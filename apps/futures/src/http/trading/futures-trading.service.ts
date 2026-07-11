import { Injectable, HttpStatus } from '@nestjs/common';
import {
  MarginMode,
  MarketType,
  Order,
  OrderStatus,
  Position,
  Prisma,
  PositionStatus,
  TimeInForce,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { KafkaService } from '@app/infra/messaging/kafka.service';
import { inboundTopic } from '@app/infra/messaging/topics';
import {
  serializeCancelOrder,
  serializeNewOrder,
} from '@app/infra/messaging/match-message.serializer';
import { TickerMeta, TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { UserService } from '@app/core-domain/user/user.service';
import { FuturesConfigService } from '../../config/futures-config.service';
import { PositionService } from '../../position/position.service';
import { MarkPriceService } from '../../mark-price/mark-price.service';
import { MarginService } from '../../margin/margin.service';
import { FuturesTriggerRegistryService } from '../../trigger/futures-trigger-registry.service';
import { FuturesUserEventsService } from '../../user-events/futures-user-events.service';
import { initialMargin, notional } from '../../math/margin-math';
import {
  assertMinNotional,
  assertNotLiquidating,
  assertReduceOnlyCapacity,
  assertReduceOnlySide,
  assertWithinMaxNotional,
  normalizeOrderFields,
  stopTriggered,
} from './futures-order-validation';
import { CreateFuturesOrderDto } from './dto/create-futures-order.dto';
import { UpdatePositionDto } from './dto/update-position.dto';
import { isStopType } from '@app/shared/order-classify';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { createOrderOrThrowDuplicate, generateClientOrderId } from '@app/shared/order-client-id';
import { MAX_OPEN_ORDERS_PER_SYMBOL } from '@app/shared/constants/trading-protection';

const MARKET = MarketType.FUTURES;
const OPEN_STATUSES: OrderStatus[] = [OrderStatus.NEW, OrderStatus.OPEN, OrderStatus.PARTIAL];
const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.FILLED,
  OrderStatus.CANCELED,
  OrderStatus.REJECTED,
  OrderStatus.EXPIRED,
]);
const ZERO = new Decimal(0);
// Position 행 없음 = leverage 미설정 — 스키마 기본값과 동일해야 worker가 만들 행과 일치
const DEFAULT_LEVERAGE = 10;

@Injectable()
export class FuturesTradingService {
  private readonly partitions = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private kafka: KafkaService,
    private tickerStats: TickerStatsService,
    private users: UserService,
    private futuresConfig: FuturesConfigService,
    private positions: PositionService,
    private markPrice: MarkPriceService,
    private margin: MarginService,
    private triggerRegistry: FuturesTriggerRegistryService,
    private userEvents: FuturesUserEventsService,
  ) {}

  // ---------- 주문 접수 ----------

  /** 검증 순서 고정: ticker/config → LIQUIDATING → mark → 밴드 → minNotional → maxNotional → reduceOnly|잠금 → NO. */
  async placeOrder(userId: string, dto: CreateFuturesOrderDto): Promise<Order> {
    const meta = this.tickerStats.metaOf(MARKET, dto.symbol);
    if (!meta)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        'Ticker not found',
        HttpStatus.NOT_FOUND,
      );
    // 상장 상태 게이트 — PENDING/HALTED/DELISTED는 신규 주문 거부 (청산·취소는 영향 없음)
    await this.tickerStats.assertTradable(MARKET, dto.symbol);
    // 계정 거래 정지 게이트
    await this.users.assertCanTrade(userId);
    const config = await this.futuresConfig.configOf(dto.symbol);

    // 심볼별 오픈주문 상한 (청산 주문 제외 — 청산은 이 경로 미경유이나 방어적으로 필터).
    // stop/일반 분기 이전에 검사 → 두 경로 모두 커버.
    const openCount = await this.prisma.order.count({
      where: {
        userId,
        tickerSymbol: dto.symbol,
        tickerMarket: MARKET,
        status: { in: OPEN_STATUSES },
        liquidation: false,
      },
    });
    if (openCount >= MAX_OPEN_ORDERS_PER_SYMBOL) {
      throw new DomainException(
        ErrorCode.MAX_NUM_ORDERS_EXCEEDED,
        `Open-order limit reached for ${dto.symbol} (max ${MAX_OPEN_ORDERS_PER_SYMBOL})`,
      );
    }

    const { price, stopPrice, qty, timeInForce } = normalizeOrderFields(dto, meta);
    const clientOrderId = dto.newClientOrderId ?? generateClientOrderId();

    const position = await this.positions.findByUserAndSymbol(userId, dto.symbol);
    assertNotLiquidating(position);
    // cross 계정 청산 중에는 전 심볼 신규 주문 차단 (다른 심볼로 노출 진입 방지)
    await this.assertAccountNotCrossLiquidating(userId);

    const mark = this.markOf(dto.symbol);

    // stop류: 트리거(mark)까지 BE 보관 — 잠금/엔진 전송 없이 registry 등록 후 반환
    if (isStopType(dto.type)) {
      return this.placeStopOrder(userId, dto, {
        meta,
        config,
        price,
        stopPrice: stopPrice!,
        qty,
        timeInForce,
        position,
        mark,
        clientOrderId,
      });
    }

    // limit-like 가격 밴드 검증 + 접수가 산정 (MARKET은 buffer 가정가)
    const admissionPrice = this.margin.admissionPriceOf({
      type: dto.type,
      side: dto.side,
      price,
      mark,
      priceBandPct: config.priceBandPct,
      marketCostBufferPct: config.marketCostBufferPct,
    });

    // MARKET notional 추정은 mark 기준
    const estNotional = notional(price ?? mark, qty);
    assertMinNotional(estNotional, meta);

    const reduceOnly = dto.reduceOnly === true;
    let cost = ZERO;
    if (reduceOnly) {
      // 감량 전용은 노출 증가가 없어 maxNotional 미적용, 잠금 없음
      const closingSide = assertReduceOnlySide(dto.side, position);
      const openReduceOnly = await this.prisma.order.findMany({
        where: {
          userId,
          tickerSymbol: dto.symbol,
          tickerMarket: MARKET,
          reduceOnly: true,
          side: closingSide,
          status: { in: OPEN_STATUSES },
        },
        select: { origQty: true, executedQty: true },
      });
      assertReduceOnlyCapacity({ qty, positionQty: position!.qty, openReduceOnly });
    } else {
      const openOrders = await this.prisma.order.findMany({
        where: {
          userId,
          tickerSymbol: dto.symbol,
          tickerMarket: MARKET,
          status: { in: OPEN_STATUSES },
          reduceOnly: false,
        },
        select: { price: true, origQty: true, executedQty: true },
      });
      assertWithinMaxNotional({
        position,
        mark,
        openOrders,
        newNotional: estNotional,
        maxNotional: config.maxNotional,
      });
      const { takerBps } = await this.users.feeRatesOf(userId);
      cost = this.margin.costOf({
        side: dto.side,
        admissionPrice,
        mark,
        qty,
        leverage: position?.leverage ?? DEFAULT_LEVERAGE,
        takerFeeBps: takerBps,
      });
    }

    const order = await createOrderOrThrowDuplicate(() =>
      this.margin.createOrder({
        userId,
        clientOrderId,
        symbol: dto.symbol,
        type: dto.type,
        side: dto.side,
        timeInForce,
        price,
        qty,
        reduceOnly,
        cost,
        lockAssetSymbol: meta.quoteAsset,
      }),
    );

    const partition = await this.partitionOf(dto.symbol);
    await this.kafka.emit(inboundTopic(MARKET), partition, serializeNewOrder(order), order.tickerSymbol);
    return order;
  }

  /**
   * stop류 접수: mark 즉시-트리거 거부 + minNotional/reduceOnly/maxNotional 검증 후 BE 보관.
   * 증거금은 발화 시 잠그므로 접수 시 무잠금 — 엔진 미전송, registry 등록.
   */
  private async placeStopOrder(
    userId: string,
    dto: CreateFuturesOrderDto,
    ctx: {
      meta: TickerMeta;
      config: { maxNotional: Decimal };
      price: Decimal | null;
      stopPrice: Decimal;
      qty: Decimal;
      timeInForce: TimeInForce;
      position: Position | null;
      mark: Decimal;
      clientOrderId: string;
    },
  ): Promise<Order> {
    const { meta, config, price, stopPrice, qty, timeInForce, position, mark, clientOrderId } = ctx;

    // 즉시 트리거(이미 조건 충족)면 거부 — Binance 동일
    if (stopTriggered(dto.type, dto.side, stopPrice, mark)) {
      throw new DomainException(
        ErrorCode.ORDER_WOULD_TRIGGER_IMMEDIATELY,
        'Order would trigger immediately at current mark price',
      );
    }

    const estNotional = notional(price ?? mark, qty);
    assertMinNotional(estNotional, meta);

    const reduceOnly = dto.reduceOnly === true;
    if (reduceOnly) {
      const closingSide = assertReduceOnlySide(dto.side, position);
      const openReduceOnly = await this.prisma.order.findMany({
        where: {
          userId,
          tickerSymbol: dto.symbol,
          tickerMarket: MARKET,
          reduceOnly: true,
          side: closingSide,
          status: { in: OPEN_STATUSES },
        },
        select: { origQty: true, executedQty: true },
      });
      assertReduceOnlyCapacity({ qty, positionQty: position!.qty, openReduceOnly });
    } else {
      const openOrders = await this.prisma.order.findMany({
        where: {
          userId,
          tickerSymbol: dto.symbol,
          tickerMarket: MARKET,
          status: { in: OPEN_STATUSES },
          reduceOnly: false,
        },
        select: { price: true, origQty: true, executedQty: true },
      });
      assertWithinMaxNotional({
        position,
        mark,
        openOrders,
        newNotional: estNotional,
        maxNotional: config.maxNotional,
      });
    }

    const order = await createOrderOrThrowDuplicate(() =>
      this.margin.createStopOrder({
        userId,
        clientOrderId,
        symbol: dto.symbol,
        type: dto.type,
        side: dto.side,
        timeInForce,
        price,
        stopPrice,
        qty,
        reduceOnly,
      }),
    );
    this.triggerRegistry.add(order);
    this.emitStopReport(order, OrderStatus.NEW);
    return order;
  }

  /** 미트리거 stop의 BE 로컬 취소 (엔진 미거주). 성공 시 true, claim 실패(=트리거 선점) 시 false. */
  private async cancelHeldStopLocally(order: Order): Promise<boolean> {
    const claim = await this.prisma.order.updateMany({
      where: { id: order.id, status: OrderStatus.NEW, triggeredAt: null },
      data: { status: OrderStatus.CANCELED },
    });
    if (claim.count !== 1) return false;
    this.triggerRegistry.remove(order.id);
    // 미트리거 stop은 잠금 없음 → 환불 불필요
    this.emitStopReport({ ...order, status: OrderStatus.CANCELED }, OrderStatus.CANCELED);
    return true;
  }

  /** 미트리거/취소 stop 라이프사이클 WS 송출 (무체결 — 디테일 필드 null). */
  private emitStopReport(order: Order, status: OrderStatus): void {
    this.userEvents.emitExecutionReport(order.userId, {
      orderId: order.id,
      clientOrderId: order.clientOrderId ?? undefined,
      symbol: order.tickerSymbol,
      side: order.side,
      type: order.type,
      timeInForce: order.timeInForce,
      price: order.price?.toFixed(8),
      origQty: order.origQty?.toFixed(8),
      executedQty: '0',
      cumulativeQuoteQty: '0',
      status,
      reduceOnly: order.reduceOnly,
      lastFilledQty: null,
      lastFilledPrice: null,
      commission: null,
      commissionAsset: null,
      tradeId: null,
      realizedPnl: null,
      ts: Date.now(),
    });
  }

  // ---------- 주문 취소 ----------

  async cancelOrder(userId: string, ref: string): Promise<Order> {
    // ref = 주문 uuid 우선, 없으면 본인 FUTURES clientOrderId로 폴백
    let order = await this.prisma.order.findUnique({ where: { id: ref } });
    if (!order) {
      order = await this.prisma.order.findFirst({
        where: { userId, tickerMarket: MARKET, clientOrderId: ref },
        orderBy: { createdAt: 'desc' },
      });
    }
    // futures 외 주문은 비노출 — cross-market 취소 구멍 차단
    if (!order || order.tickerMarket !== MARKET)
      throw new DomainException(ErrorCode.ORDER_NOT_FOUND, 'Order not found', HttpStatus.NOT_FOUND);
    if (order.userId !== userId)
      throw new DomainException(ErrorCode.FORBIDDEN, 'Not your order', HttpStatus.FORBIDDEN);
    if (TERMINAL_STATUSES.has(order.status)) {
      throw new DomainException(ErrorCode.ORDER_NOT_OPEN, `Order already ${order.status}`);
    }

    const position = await this.positions.findByUserAndSymbol(userId, order.tickerSymbol);
    assertNotLiquidating(position);

    // 미트리거 stop은 엔진 미거주 — BE 로컬 취소 (claim 실패 시 트리거 선점 → 엔진 CO로 진행)
    if (order.stopPrice !== null && order.triggeredAt === null) {
      if (await this.cancelHeldStopLocally(order)) {
        return { ...order, status: OrderStatus.CANCELED };
      }
    }

    const partition = await this.partitionOf(order.tickerSymbol);
    await this.kafka.emit(inboundTopic(MARKET), partition, serializeCancelOrder(order), order.tickerSymbol);
    return order;
  }

  /**
   * 심볼의 본인 open 주문(liquidation 제외)을 CO 일괄 발행. LIQUIDATING이면 거부.
   * 취소는 엔진이 비동기 처리 — 대상 주문 배열 반환(PENDING 의미).
   */
  async cancelOpenOrders(userId: string, symbol: string): Promise<Order[]> {
    const position = await this.positions.findByUserAndSymbol(userId, symbol);
    assertNotLiquidating(position);

    const openOrders = await this.prisma.order.findMany({
      where: {
        userId,
        tickerSymbol: symbol,
        tickerMarket: MARKET,
        status: { in: OPEN_STATUSES },
        liquidation: false,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (openOrders.length === 0) return openOrders;

    const partition = await this.partitionOf(symbol);
    for (const order of openOrders) {
      // 미트리거 stop은 BE 로컬 취소, 그 외(엔진 거주)는 CO 발행
      if (order.stopPrice !== null && order.triggeredAt === null) {
        if (await this.cancelHeldStopLocally(order)) continue;
      }
      await this.kafka.emit(inboundTopic(MARKET), partition, serializeCancelOrder(order), order.tickerSymbol);
    }
    return openOrders;
  }

  // ---------- 포지션 설정 ----------

  /** {leverage} XOR {marginDelta} XOR {marginMode}. LIQUIDATING 중 거부. */
  async updatePosition(userId: string, symbol: string, dto: UpdatePositionDto): Promise<Position> {
    const meta = this.tickerStats.metaOf(MARKET, symbol);
    if (!meta)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        'Ticker not found',
        HttpStatus.NOT_FOUND,
      );
    const config = await this.futuresConfig.configOf(symbol);

    const set = [dto.leverage, dto.marginDelta, dto.marginMode].filter(
      (v) => v !== undefined,
    ).length;
    if (set !== 1) {
      throw new DomainException(
        ErrorCode.INVALID_PARAMETER,
        'Exactly one of leverage, marginDelta or marginMode is required',
      );
    }

    const position = await this.positions.findByUserAndSymbol(userId, symbol);
    assertNotLiquidating(position);

    if (dto.leverage !== undefined) {
      return this.changeLeverage(userId, symbol, dto.leverage, config.maxLeverage, position);
    }
    if (dto.marginMode !== undefined) {
      return this.changeMarginMode(userId, symbol, dto.marginMode, position);
    }
    return this.changeMargin(userId, symbol, new Decimal(dto.marginDelta!), meta, position);
  }

  /** marginMode 변경은 qty==0일 때만. 행 없으면 설정용 빈 포지션 생성. */
  private async changeMarginMode(
    userId: string,
    symbol: string,
    marginMode: MarginMode,
    position: Position | null,
  ): Promise<Position> {
    if (!position) {
      try {
        return await this.prisma.position.create({
          data: { userId, tickerSymbol: symbol, tickerMarket: MARKET, marginMode },
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
      }
    }

    const updated = await this.prisma.position.updateMany({
      where: { userId, tickerSymbol: symbol, qty: ZERO, status: PositionStatus.NORMAL },
      data: { marginMode },
    });
    if (updated.count === 0) {
      throw new DomainException(
        ErrorCode.INVALID_PARAMETER,
        'margin mode can only be changed with no open position',
      );
    }
    return this.findPositionOrThrow(userId, symbol);
  }

  /** leverage 변경은 qty==0일 때만. NORMAL 행 없으면 설정용 빈 포지션 생성. */
  private async changeLeverage(
    userId: string,
    symbol: string,
    leverage: number,
    maxLeverage: number,
    position: Position | null,
  ): Promise<Position> {
    if (leverage < 1 || leverage > maxLeverage) {
      throw new DomainException(
        ErrorCode.INVALID_LEVERAGE,
        `leverage must be between 1 and ${maxLeverage}`,
      );
    }

    if (!position) {
      try {
        return await this.prisma.position.create({
          data: { userId, tickerSymbol: symbol, tickerMarket: MARKET, leverage },
        });
      } catch (e) {
        // 동시 생성 race — 기존 행 조건부 갱신으로 진행
        if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
      }
    }

    const updated = await this.prisma.position.updateMany({
      where: { userId, tickerSymbol: symbol, qty: ZERO, status: PositionStatus.NORMAL },
      data: { leverage },
    });
    if (updated.count === 0) {
      throw new DomainException(
        ErrorCode.INVALID_LEVERAGE,
        'leverage can only be changed with no open position',
      );
    }
    return this.findPositionOrThrow(userId, symbol);
  }

  /** +는 balance→isolatedMargin, −는 차감 후 잔여 마진 ≥ mark notional/lev 검증. */
  private async changeMargin(
    userId: string,
    symbol: string,
    delta: Decimal,
    meta: TickerMeta,
    position: Position | null,
  ): Promise<Position> {
    if (!delta.isFinite() || delta.isZero()) {
      throw new DomainException(
        ErrorCode.INVALID_MARGIN_DELTA,
        'marginDelta must be a non-zero amount',
      );
    }
    if (delta.decimalPlaces() > 8) {
      throw new DomainException(
        ErrorCode.INVALID_MARGIN_DELTA,
        'marginDelta must have at most 8 decimal places',
      );
    }
    if (!position)
      throw new DomainException(
        ErrorCode.POSITION_NOT_FOUND,
        'Position not found',
        HttpStatus.NOT_FOUND,
      );
    if (position.marginMode === MarginMode.CROSS) {
      throw new DomainException(
        ErrorCode.INVALID_MARGIN_DELTA,
        'marginDelta not allowed on cross positions (margin auto from wallet)',
      );
    }

    if (delta.gt(0)) {
      await this.prisma.$transaction(async (tx) => {
        // 잠금 순서 Position→Wallet — 정산 worker와 통일 (교착 방지)
        const updated = await tx.position.updateMany({
          where: { userId, tickerSymbol: symbol, status: PositionStatus.NORMAL },
          data: { isolatedMargin: { increment: delta } },
        });
        if (updated.count === 0) {
          throw new DomainException(
            ErrorCode.POSITION_LIQUIDATING,
            'Position not found or liquidating',
          );
        }

        const debit = await tx.wallet.updateMany({
          where: {
            userId,
            assetSymbol: meta.quoteAsset,
            marketType: MARKET,
            balance: { gte: delta },
          },
          data: { balance: { decrement: delta } },
        });
        if (debit.count === 0)
          throw new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');
      });
      return this.findPositionOrThrow(userId, symbol);
    }

    const withdraw = delta.neg();
    const required = position.qty.isZero()
      ? ZERO
      : initialMargin(notional(this.markOf(symbol), position.qty), position.leverage);

    await this.prisma.$transaction(async (tx) => {
      // qty 동결 조건 포함 원자 검증 — 검증과 차감 사이 체결 반영을 차단
      const updated = await tx.position.updateMany({
        where: {
          userId,
          tickerSymbol: symbol,
          status: PositionStatus.NORMAL,
          qty: position.qty,
          isolatedMargin: { gte: required.add(withdraw) },
        },
        data: { isolatedMargin: { decrement: withdraw } },
      });
      if (updated.count === 0) {
        throw new DomainException(
          ErrorCode.MARGIN_DELTA_EXCEEDS_WITHDRAWABLE,
          'marginDelta exceeds withdrawable margin',
        );
      }

      const credit = await tx.wallet.updateMany({
        where: { userId, assetSymbol: meta.quoteAsset, marketType: MARKET },
        data: { balance: { increment: withdraw } },
      });
      if (credit.count === 0) {
        // 마진 보유 유저의 futures wallet 부재는 회계 버그
        throw new Error(`futures ${meta.quoteAsset} wallet missing for user ${userId}`);
      }
    });
    return this.findPositionOrThrow(userId, symbol);
  }

  // ---------- infra helpers ----------

  /** cross 계정 청산 진행 중이면 신규 주문 차단(전 심볼). */
  private async assertAccountNotCrossLiquidating(userId: string): Promise<void> {
    const liquidating = await this.prisma.position.count({
      where: { userId, marginMode: MarginMode.CROSS, status: PositionStatus.LIQUIDATING },
    });
    if (liquidating > 0) {
      throw new DomainException(
        ErrorCode.POSITION_LIQUIDATING,
        'Account is liquidating (cross) — new orders blocked',
      );
    }
  }

  /** 주문 접수/마진 검증용 mark — 미형성 시 503 (fail loudly). */
  private markOf(symbol: string): Decimal {
    const mark = this.markPrice.tryGetMark(symbol);
    if (mark === null) {
      throw new DomainException(
        ErrorCode.MARK_PRICE_UNAVAILABLE,
        `mark price unavailable for ${symbol}: spot index not established`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return mark;
  }

  private async partitionOf(symbol: string): Promise<number> {
    const cached = this.partitions.get(symbol);
    if (cached !== undefined) return cached;

    const ticker = await this.prisma.ticker.findUnique({
      where: { symbol_marketType: { symbol, marketType: MARKET } },
      select: { partition: true },
    });
    if (!ticker)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        `Ticker ${symbol} not found`,
        HttpStatus.NOT_FOUND,
      );

    this.partitions.set(symbol, ticker.partition);
    return ticker.partition;
  }

  private async findPositionOrThrow(userId: string, symbol: string): Promise<Position> {
    const position = await this.positions.findByUserAndSymbol(userId, symbol);
    if (!position)
      throw new DomainException(
        ErrorCode.POSITION_NOT_FOUND,
        'Position not found',
        HttpStatus.NOT_FOUND,
      );
    return position;
  }
}
