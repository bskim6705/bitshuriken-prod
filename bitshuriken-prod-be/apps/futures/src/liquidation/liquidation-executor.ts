import { Injectable, Logger } from '@nestjs/common';
import {
  MarginMode,
  MarketType,
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
  Position,
  PositionStatus,
  Prisma,
  SettlementKind,
  SettlementStatus,
  TimeInForce,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { KafkaService } from '@app/infra/messaging/kafka.service';
import { inboundTopic } from '@app/infra/messaging/topics';
import {
  serializeCancelOrder,
  serializeNewOrder,
} from '@app/infra/messaging/match-message.serializer';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { FuturesConfigService } from '../config/futures-config.service';
import { MarkPriceService } from '../mark-price/mark-price.service';
import { FuturesUserEventsService } from '../user-events/futures-user-events.service';
import {
  type CrossLeg,
  crossAccountMarginRatio,
  isCrossAccountLiquidationTarget,
  liquidationPrice,
  maintenanceMargin,
  marginRatio,
  unrealizedPnl,
} from '../math/margin-math';

const MARKET = MarketType.FUTURES;
const ZERO = new Decimal(0);
const OPEN_STATUSES: OrderStatus[] = [OrderStatus.NEW, OrderStatus.OPEN, OrderStatus.PARTIAL];
const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.FILLED,
  OrderStatus.CANCELED,
  OrderStatus.REJECTED,
  OrderStatus.EXPIRED,
]);
const FUTURES_KINDS: SettlementKind[] = [
  SettlementKind.FUTURES_TRADE,
  SettlementKind.FUTURES_REFUND,
  SettlementKind.FUNDING,
  SettlementKind.LIQUIDATION_TAKEOVER,
];

const POLL_INTERVAL_MS = 200;
const ORDER_TERMINAL_TIMEOUT_MS = 10_000;
const SETTLEMENT_DRAIN_TIMEOUT_MS = 10_000;
// NEW·무체결로 이 시간을 넘기면 NO가 엔진에 닿지 못한 것으로 간주 (emit 실패/크래시 잔존 복구)
const NEW_ORDER_GRACE_MS = 30_000;

/** 청산 판정: marginRatio ≥ 1, 분모(margin + UPNL) ≤ 0이면 즉시 대상. */
export function isLiquidationTarget(
  position: Pick<Position, 'qty' | 'entryPrice' | 'isolatedMargin'>,
  mark: Decimal,
  mmr: Decimal,
): boolean {
  if (position.qty.isZero()) return false;
  const mm = maintenanceMargin(mmr, mark, position.qty);
  const upnl = unrealizedPnl(mark, position.entryPrice, position.qty);
  const ratio = marginRatio(mm, position.isolatedMargin, upnl);
  return ratio === null || ratio.gte(1);
}

/**
 * 청산 시퀀스 집행 — 판정/claim은 monitor 몫.
 * CO 전부 → terminal poll → 직전 청산 주문 follow → 정산 drain → 재판정 →
 * 잔여 qty IOC MARKET NO → terminal + drain 후 잔존 시 LIQUIDATION_TAKEOVER append
 * (worker가 BP 인수 + NORMAL 복귀). 모든 단계 fail loudly — 실패 시 LIQUIDATING 잔존,
 * 다음 tick 재진입으로 재시도.
 */
@Injectable()
export class LiquidationExecutor {
  private readonly logger = new Logger(LiquidationExecutor.name);
  private readonly partitions = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private kafka: KafkaService,
    private futuresConfig: FuturesConfigService,
    private markPrice: MarkPriceService,
    private userEvents: FuturesUserEventsService,
    private tickerStats: TickerStatsService,
  ) {}

  /** 청산 시퀀스. 어느 단계든 throw 시 LIQUIDATING 잔존 → 다음 tick 재진입. */
  async liquidate(userId: string, symbol: string): Promise<void> {
    await this.cancelOpenOrders(userId, symbol);
    await this.waitOrdersTerminal(userId, symbol);
    // 직전 청산 주문을 terminal까지 follow — 이후 drain 스냅샷이 그 체결 TR을 포함 (중복 NO 차단)
    await this.resolveInflightLiquidationOrder(userId, symbol);
    await this.waitSettlementDrain(); // 잔여 qty 확정

    let position = await this.findPosition(userId, symbol);
    if (position.status !== PositionStatus.LIQUIDATING) return; // drain 중 worker가 종결
    if (position.qty.isZero()) {
      await this.restoreNormal(userId, symbol);
      return;
    }

    // drain 반영 후 재판정 — in-flight 체결/마진 추가로 건전해졌으면 강제 청산 중단
    const config = await this.futuresConfig.configOf(symbol);
    if (!isLiquidationTarget(position, this.markPrice.getMark(symbol), config.mmr)) {
      await this.restoreNormal(userId, symbol);
      return;
    }

    const order = await this.ensureLiquidationOrder(userId, symbol, position.qty);
    await this.waitOrderTerminal(order.id);
    await this.waitSettlementDrain();

    position = await this.findPosition(userId, symbol);
    if (position.qty.isZero()) {
      await this.restoreNormal(userId, symbol);
      return;
    }

    // IOC 잔여 — 보험기금이 BP로 인수. NORMAL 복귀는 worker의 takeover apply가 수행
    await this.appendTakeover(userId, symbol);
    this.logger.warn(
      `liquidation takeover appended: user=${userId} ${symbol} residualQty=${position.qty.toFixed(8)}`,
    );
  }

  // ---------- cross 계정 일괄 청산 ----------

  /**
   * cross 계정 청산 — 유저의 LIQUIDATING cross 포지션 전부를 심볼별로 닫는다.
   * 모든 cross open 주문 CO → drain 후 계정 재판정(회복 시 전부 NORMAL) → 각 심볼 IOC MARKET 청산
   * → 잔존분 BP 인수. 어느 단계든 throw 시 LIQUIDATING 잔존 → 다음 tick 재진입(멱등).
   */
  async liquidateCross(userId: string): Promise<void> {
    let positions = await this.findCrossLiquidating(userId);
    if (positions.length === 0) return;

    // 집행 전 계정 재판정 — claim~여기 사이 회복됐으면 전부 NORMAL 복귀
    if (!(await this.isCrossAccountBreached(userId, positions))) {
      await this.restoreCrossNormal(positions);
      return;
    }

    // 모든 cross 심볼 open 주문 CO → terminal → in-flight 청산 주문 follow
    for (const p of positions) await this.cancelOpenOrders(userId, p.tickerSymbol);
    for (const p of positions) {
      await this.waitOrdersTerminal(userId, p.tickerSymbol);
      await this.resolveInflightLiquidationOrder(userId, p.tickerSymbol);
    }
    await this.waitSettlementDrain();

    positions = await this.findCrossLiquidating(userId);
    if (positions.length === 0) return;
    // drain 반영 후 재판정 — 체결/마크 회복으로 건전해졌으면 강제 청산 중단
    if (!(await this.isCrossAccountBreached(userId, positions))) {
      await this.restoreCrossNormal(positions);
      return;
    }

    // 각 심볼 잔여 qty IOC MARKET 청산
    for (const p of positions) {
      if (p.qty.isZero()) continue;
      const order = await this.ensureLiquidationOrder(userId, p.tickerSymbol, p.qty);
      await this.waitOrderTerminal(order.id);
    }
    await this.waitSettlementDrain();

    // 심볼별 잔존분 BP 인수 / 전량 close된 심볼은 NORMAL 복귀
    positions = await this.findCrossLiquidating(userId);
    for (const p of positions) {
      const fresh = await this.findPosition(userId, p.tickerSymbol);
      if (fresh.status !== PositionStatus.LIQUIDATING) continue; // worker가 종결
      if (fresh.qty.isZero()) {
        await this.restoreNormal(userId, p.tickerSymbol);
        continue;
      }
      await this.appendTakeover(userId, p.tickerSymbol);
      this.logger.warn(
        `cross liquidation takeover appended: user=${userId} ${p.tickerSymbol} residualQty=${fresh.qty.toFixed(8)}`,
      );
    }
  }

  /** 계정 단위 cross 청산 판정 — 현재 mark 기준 crossEquity ≤ crossMM. mark 미형성 시 false(다음 tick 재평가). */
  async isCrossAccountBreached(userId: string, positions: Position[]): Promise<boolean> {
    const account = await this.crossAccount(userId, positions);
    if (!account) return false;
    return isCrossAccountLiquidationTarget(account.freeBalance, account.legs);
  }

  /**
   * 계정 단위 cross marginRatio — MARGIN_CALL warn 판정용. mark 일부 부재/leg 0개면 null.
   * 청산 판정(isCrossAccountBreached)과 동일 입력으로 산출.
   */
  async crossAccountRatio(userId: string, positions: Position[]): Promise<Decimal | null> {
    const account = await this.crossAccount(userId, positions);
    if (!account) return null;
    return crossAccountMarginRatio(account.freeBalance, account.legs);
  }

  /** cross 계정 leg + free balance 집계. 일부 mark 부재/leg 0개/quote 미상이면 null. */
  private async crossAccount(
    userId: string,
    positions: Position[],
  ): Promise<{ freeBalance: Decimal; legs: CrossLeg[] } | null> {
    const legs: CrossLeg[] = [];
    let quoteAsset: string | null = null;
    for (const p of positions) {
      if (p.qty.isZero()) continue;
      const mark = this.markPrice.tryGetMark(p.tickerSymbol);
      if (mark === null) return null; // 계정 일부 mark 부재 — 안전하게 판정 보류
      const config = await this.futuresConfig.configOf(p.tickerSymbol);
      legs.push({
        isolatedMargin: p.isolatedMargin,
        upnl: unrealizedPnl(mark, p.entryPrice, p.qty),
        mm: maintenanceMargin(config.mmr, mark, p.qty),
      });
      quoteAsset ??= this.tickerStats.metaOf(MARKET, p.tickerSymbol)?.quoteAsset ?? null;
    }
    if (legs.length === 0 || quoteAsset === null) return null;
    const freeBalance = await this.freeFuturesBalance(userId, quoteAsset);
    return { freeBalance, legs };
  }

  findCrossLiquidating(userId: string): Promise<Position[]> {
    return this.prisma.position.findMany({
      where: { userId, marginMode: MarginMode.CROSS, status: PositionStatus.LIQUIDATING },
      orderBy: { tickerSymbol: 'asc' },
    });
  }

  private async restoreCrossNormal(positions: Position[]): Promise<void> {
    for (const p of positions) await this.restoreNormal(p.userId, p.tickerSymbol);
  }

  /** 유저 FUTURES quote 지갑의 free balance — cross 담보. 행 없으면 0. */
  private async freeFuturesBalance(userId: string, assetSymbol: string): Promise<Decimal> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_assetSymbol_marketType: { userId, assetSymbol, marketType: MARKET } },
      select: { balance: true },
    });
    return wallet?.balance ?? new Decimal(0);
  }

  // ---------- 시퀀스 단계 ----------

  /** OPEN 계열 주문 전부 CO 발행. liquidation 주문은 IOC라 book 잔류 없음 — 제외. */
  private async cancelOpenOrders(userId: string, symbol: string): Promise<void> {
    const openOrders = await this.prisma.order.findMany({
      where: {
        userId,
        tickerSymbol: symbol,
        tickerMarket: MARKET,
        status: { in: OPEN_STATUSES },
        liquidation: false,
      },
    });
    if (openOrders.length === 0) return;

    const partition = await this.partitionOf(symbol);
    for (const order of openOrders) {
      // CO 재발행 무해 (엔진이 모르는 주문은 무시)
      await this.kafka.emit(inboundTopic(MARKET), partition, serializeCancelOrder(order), order.tickerSymbol);
    }
  }

  /** user+symbol의 비청산 주문이 전부 terminal 될 때까지 poll. 초과 시 throw → 재시도. */
  private async waitOrdersTerminal(userId: string, symbol: string): Promise<void> {
    const deadline = Date.now() + ORDER_TERMINAL_TIMEOUT_MS;
    for (;;) {
      const open = await this.prisma.order.count({
        where: {
          userId,
          tickerSymbol: symbol,
          tickerMarket: MARKET,
          status: { in: OPEN_STATUSES },
          liquidation: false,
        },
      });
      if (open === 0) return;
      if (Date.now() > deadline) {
        // 엔진 미도달 NEW 주문 복구 후 throw — 다음 tick 재진입 시 통과 (영구 LIQUIDATING 차단)
        await this.rejectUndispatchedUserOrders(userId, symbol);
        throw new Error(
          `open orders for ${userId}/${symbol} not terminal within ${ORDER_TERMINAL_TIMEOUT_MS}ms (${open} remaining)`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** timeout 복구: grace 경과한 NEW 유저 주문을 REJECTED + 잔여 잠금 환불 처리. */
  private async rejectUndispatchedUserOrders(userId: string, symbol: string): Promise<void> {
    const staleOrders = await this.prisma.order.findMany({
      where: {
        userId,
        tickerSymbol: symbol,
        tickerMarket: MARKET,
        status: OrderStatus.NEW,
        liquidation: false,
      },
    });
    for (const order of staleOrders) {
      await this.rejectUndispatched(order);
    }
  }

  /** 가장 최근 청산 주문 follow: OPEN이면 terminal 대기, 엔진 미도달 NEW는 REJECTED 처리. */
  private async resolveInflightLiquidationOrder(userId: string, symbol: string): Promise<void> {
    const latest = await this.prisma.order.findFirst({
      where: { userId, tickerSymbol: symbol, tickerMarket: MARKET, liquidation: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest || TERMINAL_STATUSES.has(latest.status)) return;
    if (await this.rejectUndispatched(latest)) return;
    await this.waitOrderTerminal(latest.id);
  }

  /**
   * 생성 후 grace 내내 NEW·무체결(Trade 0건)이면 NO가 엔진에 닿지 못한 것으로 간주해 REJECTED.
   * 늦은 OU가 와도 consume은 terminal을 덮어쓰지 않고 환불은 sourceKey로 멱등.
   */
  private async rejectUndispatched(order: Order): Promise<boolean> {
    if (order.status !== OrderStatus.NEW) return false;
    if (Date.now() - order.createdAt.getTime() < NEW_ORDER_GRACE_MS) return false;
    if (!order.executedQty.isZero()) return false;
    const trades = await this.prisma.trade.count({
      where: { OR: [{ makerOrderId: order.id }, { takerOrderId: order.id }] },
    });
    if (trades > 0) return false;

    const rejected = await this.prisma.order.updateMany({
      where: { id: order.id, status: OrderStatus.NEW },
      data: { status: OrderStatus.REJECTED },
    });
    if (rejected.count !== 1) return false;
    this.logger.error(`order ${order.id} never reached engine — marked REJECTED`);

    if (order.lockedCost !== null && order.lockedCost.gt(0)) {
      // consume의 terminal 환불과 동일 형식·sourceKey — 중복 append는 unique로 무해
      try {
        await this.prisma.settlementEvent.create({
          data: {
            sourceKey: `frefund:${order.id}`,
            kind: SettlementKind.FUTURES_REFUND,
            legs: [
              {
                orderId: order.id,
                userId: order.userId,
                finalExecutedQty: order.executedQty.toString(),
              },
            ] as unknown as Prisma.InputJsonValue,
            orderLegs: [] as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
    return true;
  }

  /** 진입 시점 PENDING futures 이벤트(seq ≤ watermark)가 전부 적용될 때까지 대기. */
  private async waitSettlementDrain(): Promise<void> {
    const head = await this.prisma.settlementEvent.findFirst({
      where: { status: SettlementStatus.PENDING, kind: { in: FUTURES_KINDS } },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    if (!head) return;

    const deadline = Date.now() + SETTLEMENT_DRAIN_TIMEOUT_MS;
    for (;;) {
      const remaining = await this.prisma.settlementEvent.count({
        where: {
          status: SettlementStatus.PENDING,
          kind: { in: FUTURES_KINDS },
          seq: { lte: head.seq },
        },
      });
      if (remaining === 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          `settlement drain timed out after ${SETTLEMENT_DRAIN_TIMEOUT_MS}ms (${remaining} events <= seq ${head.seq} pending)`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /**
   * 잔여 qty 청산용 IOC MARKET NO — 유저 명의, liquidation=true, lockedCost=0 (잠금/검증 스킵).
   * 재진입 시 OPEN liquidation 주문이 이미 있으면 재발행하지 않고 그 주문을 따라간다 (중복 NO 방지).
   */
  private async ensureLiquidationOrder(
    userId: string,
    symbol: string,
    qty: Decimal,
  ): Promise<Order> {
    const existing = await this.prisma.order.findFirst({
      where: {
        userId,
        tickerSymbol: symbol,
        tickerMarket: MARKET,
        liquidation: true,
        status: { in: OPEN_STATUSES },
      },
    });
    if (existing) {
      this.logger.warn(
        `reusing in-flight liquidation order ${existing.id} for ${userId}/${symbol}`,
      );
      return existing;
    }

    const partition = await this.partitionOf(symbol);
    const order = await this.prisma.order.create({
      data: {
        userId,
        tickerSymbol: symbol,
        tickerMarket: MARKET,
        type: OrderType.MARKET,
        side: qty.isNegative() ? OrderSide.BUY : OrderSide.SELL,
        timeInForce: TimeInForce.IOC,
        origQty: qty.abs(),
        reduceOnly: false,
        liquidation: true,
        lockedCost: ZERO,
        status: OrderStatus.NEW,
      },
    });

    try {
      await this.kafka.emit(inboundTopic(MARKET), partition, serializeNewOrder(order), order.tickerSymbol);
    } catch (e) {
      // 엔진 미도달 주문 잔존 방지 — REJECTED 후 rethrow, 다음 재진입이 새 NO 생성
      await this.prisma.order.updateMany({
        where: { id: order.id, status: OrderStatus.NEW },
        data: { status: OrderStatus.REJECTED },
      });
      throw e;
    }
    return order;
  }

  private async waitOrderTerminal(orderId: string): Promise<void> {
    const deadline = Date.now() + ORDER_TERMINAL_TIMEOUT_MS;
    for (;;) {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      if (!order) throw new Error(`liquidation order ${orderId} not found`);
      if (TERMINAL_STATUSES.has(order.status)) return;
      if (Date.now() > deadline) {
        throw new Error(
          `liquidation order ${orderId} not terminal within ${ORDER_TERMINAL_TIMEOUT_MS}ms`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** 잔여 인수 이벤트 — legs는 worker의 모니터 생산 형태({userId, symbol}만). */
  private async appendTakeover(userId: string, symbol: string): Promise<void> {
    await this.prisma.settlementEvent.create({
      data: {
        sourceKey: `takeover:${userId}:${symbol}:${randomUUID()}`,
        kind: SettlementKind.LIQUIDATION_TAKEOVER,
        legs: [{ userId, symbol }] as unknown as Prisma.InputJsonValue,
        orderLegs: [] as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // ---------- monitor 공유 helpers ----------

  /** LIQUIDATING → NORMAL 복귀 + fuser 통지. monitor의 재검증 release도 사용. */
  async restoreNormal(userId: string, symbol: string): Promise<void> {
    const restored = await this.prisma.position.updateMany({
      where: { userId, tickerSymbol: symbol, status: PositionStatus.LIQUIDATING },
      data: { status: PositionStatus.NORMAL },
    });
    if (restored.count === 1) {
      const row = await this.prisma.position.findUnique({
        where: { userId_tickerSymbol: { userId, tickerSymbol: symbol } },
      });
      if (row) await this.emitPosition(row);
    }
    this.logger.log(`liquidation released: user=${userId} ${symbol} (NORMAL restored)`);
  }

  /**
   * 직접 전이(claim/restore)도 /ws/fuser로 통지 — worker 스냅샷과 동일 형식.
   * mark가 있으면 mark/UPNL을, ISOLATED는 청산가까지 채운다. CROSS 청산가는 null(FE가 REST 보충).
   */
  async emitPosition(position: Position): Promise<void> {
    const mark = this.markPrice.tryGetMark(position.tickerSymbol);
    let markPriceStr: string | null = null;
    let upnlStr: string | null = null;
    let liqPriceStr: string | null = null;
    if (mark !== null && !position.qty.isZero()) {
      markPriceStr = mark.toFixed(8);
      upnlStr = unrealizedPnl(mark, position.entryPrice, position.qty).toFixed(8);
      if (position.marginMode === MarginMode.ISOLATED) {
        const { mmr } = await this.futuresConfig.configOf(position.tickerSymbol);
        liqPriceStr = liquidationPrice(
          position.entryPrice,
          position.qty,
          position.isolatedMargin,
          mmr,
        ).toFixed(8);
      }
    }
    this.userEvents.emitPositionUpdate(position.userId, [
      {
        symbol: position.tickerSymbol,
        qty: position.qty.toFixed(8),
        entryPrice: position.entryPrice.toFixed(8),
        isolatedMargin: position.isolatedMargin.toFixed(8),
        leverage: position.leverage,
        marginMode: position.marginMode,
        status: position.status,
        markPrice: markPriceStr,
        unrealizedPnl: upnlStr,
        liquidationPrice: liqPriceStr,
        ts: position.updatedAt.getTime(),
      },
    ]);
  }

  async findPosition(userId: string, symbol: string): Promise<Position> {
    const position = await this.prisma.position.findUnique({
      where: { userId_tickerSymbol: { userId, tickerSymbol: symbol } },
    });
    if (!position) throw new Error(`position not found for ${userId}/${symbol}`);
    return position;
  }

  private async partitionOf(symbol: string): Promise<number> {
    const cached = this.partitions.get(symbol);
    if (cached !== undefined) return cached;

    const ticker = await this.prisma.ticker.findUnique({
      where: { symbol_marketType: { symbol, marketType: MARKET } },
      select: { partition: true },
    });
    if (!ticker) throw new Error(`Ticker FUTURES/${symbol} not found`);

    this.partitions.set(symbol, ticker.partition);
    return ticker.partition;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
