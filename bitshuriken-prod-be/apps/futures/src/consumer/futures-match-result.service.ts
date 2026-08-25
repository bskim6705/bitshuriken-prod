import { Injectable, Logger } from '@nestjs/common';
import {
  MarketType,
  Order,
  OrderStatus,
  OrderType,
  Prisma,
  SettlementKind,
  TimeInForce,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { UserService } from '@app/core-domain/user/user.service';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { OrderUpdateData, TradeData } from '@app/infra/messaging/match-message.parser';
import { ceil8 } from '@app/shared/decimal';
import { FuturesUserEventsService } from '../user-events/futures-user-events.service';
import {
  FuturesOrderLeg,
  FuturesRefundLeg,
  FuturesTradeLeg,
} from '../settlement/futures-settlement.types';

const MARKET: MarketType = MarketType.FUTURES;
const USDT = 'USDT';
const BPS_DENOMINATOR = new Decimal(10000);

export const TERMINAL_FUTURES_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);

@Injectable()
export class FuturesMatchResultService {
  private readonly logger = new Logger(FuturesMatchResultService.name);

  constructor(
    private prisma: PrismaService,
    private users: UserService,
    private tickerStats: TickerStatsService,
    private userEvents: FuturesUserEventsService,
  ) {}

  /**
   * TR 처리: Trade insert + FUTURES_TRADE event append를 한 트랜잭션으로.
   * legs에는 raw 체결 사실만 — EP/RPNL/마진은 worker가 Position을 잠근 apply 시점에 계산.
   * 반환: 신규 trade면 true — 중복(replay)이면 false, 호출자가 stats/fanout 재실행 차단.
   */
  async handleTrade(trade: TradeData): Promise<boolean> {
    const meta = this.tickerStats.metaOf(MARKET, trade.symbol);
    if (!meta) {
      this.logger.error(`unknown futures ticker ${trade.symbol}`);
      return false;
    }

    const [makerRates, takerRates] = await Promise.all([
      this.users.feeRatesOf(trade.makerUserId, MarketType.FUTURES),
      this.users.feeRatesOf(trade.takerUserId, MarketType.FUTURES),
    ]);

    // 수수료 = notional×bps, USDT 차감(ceil) — worker feeOf와 동일 라운딩
    const quoteUsed = trade.price.mul(trade.qty);
    const makerCommission = ceil8(quoteUsed.mul(makerRates.makerBps).div(BPS_DENOMINATOR));
    const takerCommission = ceil8(quoteUsed.mul(takerRates.takerBps).div(BPS_DENOMINATOR));

    const fillLeg: FuturesTradeLeg = {
      symbol: trade.symbol,
      price: trade.price.toString(),
      qty: trade.qty.toString(),
      makerOrderId: trade.makerOrderId,
      makerUserId: trade.makerUserId,
      takerOrderId: trade.takerOrderId,
      takerUserId: trade.takerUserId,
      takerSide: trade.takerSide,
      makerFeeBps: makerRates.makerBps,
      takerFeeBps: takerRates.takerBps,
    };
    const orderLegs: FuturesOrderLeg[] = [trade.makerOrderId, trade.takerOrderId].map(
      (orderId) => ({
        orderId,
        executedQtyDelta: trade.qty.toString(),
        cumulativeQuoteQtyDelta: quoteUsed.toString(),
      }),
    );

    try {
      await this.prisma.$transaction([
        this.prisma.trade.create({
          data: {
            id: trade.tradeId,
            tickerSymbol: trade.symbol,
            tickerMarket: MARKET,
            makerOrderId: trade.makerOrderId,
            takerOrderId: trade.takerOrderId,
            makerUserId: trade.makerUserId,
            takerUserId: trade.takerUserId,
            takerSide: trade.takerSide,
            price: trade.price,
            qty: trade.qty,
            makerCommission,
            takerCommission,
            makerCommissionAsset: USDT,
            takerCommissionAsset: USDT,
            executedAt: new Date(trade.ts),
          },
        }),
        this.prisma.settlementEvent.create({
          data: {
            sourceKey: trade.tradeId,
            kind: SettlementKind.FUTURES_TRADE,
            legs: [fillLeg] as unknown as Prisma.InputJsonValue,
            orderLegs: orderLegs as unknown as Prisma.InputJsonValue,
          },
        }),
      ]);
      return true;
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        this.logger.debug(`duplicate futures trade ${trade.tradeId} — skip`);
        return false;
      }
      throw e;
    }
  }

  /**
   * OU 처리: status 동기 update + terminal이면 잔여 lockedCost 환불 event append.
   * eq/cqq는 OU 메시지 값 사용 (DB는 worker가 비동기 반영).
   */
  async handleOrderUpdate(update: OrderUpdateData): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: update.orderId } });
    if (!order) {
      this.logger.error(`unknown futures order ${update.orderId}`);
      return;
    }
    const meta = this.tickerStats.metaOf(MARKET, order.tickerSymbol);
    if (!meta) {
      this.logger.error(`no ticker meta for ${MARKET}/${order.tickerSymbol}`);
      return;
    }

    // 엔진은 MARKET/IOC 부분체결 잔여 종결의 최종 OU를 P로 발행 — 종결(EXPIRED)로 매핑 (spot과 동일 의미론)
    let status = update.status;
    if (
      status === 'PARTIAL' &&
      (order.type === OrderType.MARKET || order.timeInForce === TimeInForce.IOC)
    ) {
      status = 'EXPIRED';
    }

    const wasTerminal = TERMINAL_FUTURES_ORDER_STATUSES.has(order.status);
    const isTerminal = TERMINAL_FUTURES_ORDER_STATUSES.has(status);

    if (isTerminal) {
      if (wasTerminal) {
        // 재전달: status는 이미 terminal — 환불 INSERT만 재시도 (sourceKey unique 멱등)
        await this.recordRefund(order, update.executedQty);
      } else {
        // terminal 기록 + 환불 INSERT를 한 트랜잭션으로 — 둘 사이 크래시 시 환불 유실 방지
        await this.prisma.$transaction(async (tx) => {
          await tx.order.update({ where: { id: order.id }, data: { status } });
          await this.recordRefund(order, update.executedQty, tx);
        });
      }
    } else if (!wasTerminal) {
      await this.prisma.order.update({ where: { id: order.id }, data: { status } });
    }

    const fill = await this.lastFillDetail(order, meta);

    // 모든 OU마다 발행 (status 무변경 P 반복·replay 중복 포함 — 표시 전용이라 허용). eq/cqq는 OU 메시지 값.
    this.userEvents.emitExecutionReport(order.userId, {
      orderId: order.id,
      clientOrderId: order.clientOrderId ?? undefined,
      symbol: order.tickerSymbol,
      side: order.side,
      type: order.type,
      timeInForce: order.timeInForce,
      price: order.price !== null ? order.price.toFixed(meta.pricePrecision) : undefined,
      origQty: order.origQty !== null ? order.origQty.toFixed(meta.qtyPrecision) : undefined,
      executedQty: update.executedQty.toFixed(meta.qtyPrecision),
      cumulativeQuoteQty: update.cumulativeQuoteQty.toFixed(meta.pricePrecision),
      status: wasTerminal ? order.status : status,
      reduceOnly: order.reduceOnly,
      lastFilledQty: fill.lastFilledQty,
      lastFilledPrice: fill.lastFilledPrice,
      commission: fill.commission,
      commissionAsset: fill.commissionAsset,
      tradeId: fill.tradeId,
      realizedPnl: fill.realizedPnl,
      ts: update.ts,
    });
  }

  /**
   * 직전 체결 1건의 per-fill 디테일 — 주문의 최신 Trade 행 + 해당 REALIZED_PNL 원장.
   * 무체결 주문이면 전부 null. realizedPnl은 정산 worker가 비동기 반영하므로 미적용 시 null.
   */
  private async lastFillDetail(
    order: Order,
    meta: { pricePrecision: number; qtyPrecision: number },
  ): Promise<{
    lastFilledQty: string | null;
    lastFilledPrice: string | null;
    commission: string | null;
    commissionAsset: string | null;
    tradeId: string | null;
    realizedPnl: string | null;
  }> {
    const empty = {
      lastFilledQty: null,
      lastFilledPrice: null,
      commission: null,
      commissionAsset: null,
      tradeId: null,
      realizedPnl: null,
    };
    const trade = await this.prisma.trade.findFirst({
      where: { OR: [{ makerOrderId: order.id }, { takerOrderId: order.id }] },
      orderBy: { seq: 'desc' },
    });
    if (!trade) return empty;

    const isMaker = trade.makerOrderId === order.id;
    const role = isMaker ? 'maker' : 'taker';
    const realized = await this.prisma.futuresIncome.findUnique({
      where: { sourceKey: `${trade.id}:${role}:REALIZED_PNL` },
      select: { income: true },
    });

    return {
      lastFilledQty: trade.qty.toFixed(meta.qtyPrecision),
      lastFilledPrice: trade.price.toFixed(meta.pricePrecision),
      commission: (isMaker ? trade.makerCommission : trade.takerCommission).toFixed(8),
      commissionAsset: isMaker ? trade.makerCommissionAsset : trade.takerCommissionAsset,
      tradeId: trade.id,
      realizedPnl: realized ? realized.income.toFixed(8) : null,
    };
  }

  /** terminal 주문의 잔여 lockedCost 환불 event. lockedCost 없으면(reduceOnly/청산) noop. */
  private async recordRefund(
    order: Order,
    finalExecutedQty: Decimal,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    if (order.lockedCost === null || order.lockedCost.lte(0)) return;

    const leg: FuturesRefundLeg = {
      orderId: order.id,
      userId: order.userId,
      finalExecutedQty: finalExecutedQty.toString(),
    };
    try {
      await tx.settlementEvent.create({
        data: {
          sourceKey: `frefund:${order.id}`,
          kind: SettlementKind.FUTURES_REFUND,
          legs: [leg] as unknown as Prisma.InputJsonValue,
          orderLegs: [] as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        this.logger.debug(`duplicate futures refund event ${order.id} — skip`);
        return;
      }
      throw e;
    }
  }

  private isUniqueViolation(e: unknown): boolean {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
  }
}
