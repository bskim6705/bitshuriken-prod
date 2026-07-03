import { Injectable, HttpStatus } from '@nestjs/common';
import { MarketType, Order, OrderStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { UserService } from '@app/core-domain/user/user.service';
import { UserStreamService } from '../user-stream/user-stream.service';
import { SettlementService } from '../settlement/settlement.service';
import { TriggerRegistryService } from '../trigger/trigger-registry.service';
import { OrderListService } from '../order-list/order-list.service';
import { OrderDispatchService } from './order-dispatch.service';
import { isStopType } from '@app/shared/order-classify';
import { stopTriggered, validateAgainstMeta, validateDtoCombination } from './order-validation';
import { lockFor } from './order-lock';
import { buildExecutionReport } from './execution-report';
import { CreateOrderDto } from './dto/create-order.dto';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { createOrderOrThrowDuplicate, generateClientOrderId } from '@app/shared/order-client-id';

const OPEN_STATUSES: OrderStatus[] = ['NEW', 'OPEN', 'PARTIAL'];
const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);

const ZERO = new Decimal(0);
const MAX_HISTORY_LIMIT = 500;

export interface ReplaceOrderResult {
  order: Order;
  replaced: { orderId: string; cancelRequested: true };
}

@Injectable()
export class OrderService {
  constructor(
    private prisma: PrismaService,
    private tickerStats: TickerStatsService,
    private userStream: UserStreamService,
    private settlement: SettlementService,
    private registry: TriggerRegistryService,
    private orderLists: OrderListService,
    private dispatch: OrderDispatchService,
    private users: UserService,
  ) {}

  // ---------- write ----------

  async submitNewOrder(userId: string, dto: CreateOrderDto): Promise<Order | ReplaceOrderResult> {
    if (!dto.replacesOrderId) {
      return this.placeOrder(userId, dto);
    }

    // cancel-replace: 검증 → 신규 placement 먼저 → 기존 취소. 비원자 — 잠금 일시 공존.
    const old = await this.prisma.order.findUnique({ where: { id: dto.replacesOrderId } });
    if (!old)
      throw new DomainException(
        ErrorCode.ORDER_NOT_FOUND,
        'Replaced order not found',
        HttpStatus.NOT_FOUND,
      );
    if (old.userId !== userId)
      throw new DomainException(ErrorCode.FORBIDDEN, 'Not your order', HttpStatus.FORBIDDEN);
    if (TERMINAL_STATUSES.has(old.status)) {
      throw new DomainException(ErrorCode.ORDER_NOT_OPEN, `Replaced order already ${old.status}`);
    }
    if (old.orderListId !== null) {
      throw new DomainException(ErrorCode.ORDER_REPLACE_REJECTED, 'Cannot replace an OCO leg');
    }
    if (old.tickerSymbol !== dto.tickerSymbol || old.tickerMarket !== dto.tickerMarket) {
      throw new DomainException(
        ErrorCode.ORDER_REPLACE_REJECTED,
        'Replaced order must be for the same symbol',
      );
    }

    const order = await this.placeOrder(userId, dto);
    await this.cancelSingle(old);
    return { order, replaced: { orderId: old.id, cancelRequested: true } };
  }

  async submitCancelOrder(userId: string, ref: string) {
    // ref = 주문 uuid 또는 clientOrderId
    const order = await this.findOneForUser(userId, ref);
    if (TERMINAL_STATUSES.has(order.status)) {
      throw new DomainException(ErrorCode.ORDER_NOT_OPEN, `Order already ${order.status}`);
    }

    // OCO 레그면 리스트 전체 취소로 라우팅 (Binance 의미론)
    if (order.orderListId !== null) {
      return this.orderLists.cancelList(userId, order.orderListId);
    }

    return this.cancelSingle(order);
  }

  /** 특정 심볼의 본인 open 주문 일괄 취소. 대상 주문 배열 반환 (취소는 비동기 진행). */
  async cancelAllOpen(userId: string, market: MarketType, symbol: string): Promise<Order[]> {
    const orders = await this.prisma.order.findMany({
      where: { userId, tickerSymbol: symbol, tickerMarket: market, status: { in: OPEN_STATUSES } },
      orderBy: { createdAt: 'asc' },
    });

    const handledLists = new Set<string>();
    const result: Order[] = [];
    for (const order of orders) {
      if (order.orderListId !== null) {
        if (!handledLists.has(order.orderListId)) {
          handledLists.add(order.orderListId);
          await this.orderLists.cancelList(userId, order.orderListId, { idempotent: true });
        }
        result.push(order);
        continue;
      }
      result.push(await this.cancelSingle(order));
    }
    return result;
  }

  // ---------- read ----------

  findOpenOrders(userId: string, market: MarketType, symbol?: string) {
    return this.prisma.order.findMany({
      where: {
        userId,
        tickerMarket: market,
        status: { in: OPEN_STATUSES },
        ...(symbol ? { tickerSymbol: symbol } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  findHistory(
    userId: string,
    market: MarketType,
    opts: { symbol?: string; limit: number; endTime?: number },
  ) {
    const safeLimit = Math.min(Math.max(1, opts.limit), MAX_HISTORY_LIMIT);
    return this.prisma.order.findMany({
      where: {
        userId,
        tickerMarket: market,
        ...(opts.symbol ? { tickerSymbol: opts.symbol } : {}),
        // 커서는 inclusive(lte) — 같은 ms의 경계 행 누락 방지 (FE가 id로 dedupe)
        ...(opts.endTime !== undefined ? { createdAt: { lte: new Date(opts.endTime) } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: safeLimit,
    });
  }

  /** ref = 주문 uuid 우선, 없으면 본인 SPOT clientOrderId로 폴백 해석. */
  async findOneForUser(userId: string, ref: string) {
    let order = await this.prisma.order.findUnique({ where: { id: ref } });
    if (!order) {
      order = await this.prisma.order.findFirst({
        where: { userId, tickerMarket: MarketType.SPOT, clientOrderId: ref },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!order)
      throw new DomainException(ErrorCode.ORDER_NOT_FOUND, 'Order not found', HttpStatus.NOT_FOUND);
    if (order.userId !== userId)
      throw new DomainException(ErrorCode.FORBIDDEN, 'Not your order', HttpStatus.FORBIDDEN);
    return order;
  }

  // ---------- placement ----------

  private async placeOrder(userId: string, dto: CreateOrderDto): Promise<Order> {
    validateDtoCombination(dto);

    const meta = this.tickerStats.metaOf(dto.tickerMarket, dto.tickerSymbol);
    if (!meta)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        'Ticker not found',
        HttpStatus.NOT_FOUND,
      );

    // 상장 상태 게이트 — PENDING/HALTED/DELISTED는 신규 주문 거부 (취소는 영향 없음)
    await this.tickerStats.assertTradable(dto.tickerMarket, dto.tickerSymbol);
    // 계정 거래 정지 게이트
    await this.users.assertCanTrade(userId);

    const price = dto.price !== undefined ? new Decimal(dto.price) : null;
    const stopPrice = dto.stopPrice !== undefined ? new Decimal(dto.stopPrice) : null;
    const origQty = dto.origQty !== undefined ? new Decimal(dto.origQty) : null;
    const origQuoteQty = dto.origQuoteQty !== undefined ? new Decimal(dto.origQuoteQty) : null;

    const last = await this.lastPriceOf(dto.tickerMarket, dto.tickerSymbol);

    // 즉시 트리거 조건 충족이면 거부. 트리거는 last *체결가* 기준이라 체결 이력 전무(last null)면
    // 즉시 트리거가 논리적으로 불가능 → 검사 생략이 정상(첫 체결 시 트리거 로직이 평가). 의도된 동작.
    if (isStopType(dto.type) && last !== null) {
      if (stopTriggered(dto.type, dto.side, stopPrice!, last)) {
        throw new DomainException(
          ErrorCode.ORDER_WOULD_TRIGGER_IMMEDIATELY,
          'Order would trigger immediately.',
        );
      }
    }

    validateAgainstMeta({
      type: dto.type,
      side: dto.side,
      price,
      stopPrice,
      origQty,
      origQuoteQty,
      meta,
      lastPrice: last,
    });

    const lock = lockFor({ type: dto.type, side: dto.side, price, origQty, origQuoteQty, meta });
    const clientOrderId = dto.newClientOrderId ?? generateClientOrderId();

    const created = await createOrderOrThrowDuplicate(() =>
      this.prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({
          where: {
            userId_assetSymbol_marketType: {
              userId,
              assetSymbol: lock.assetSymbol,
              marketType: dto.tickerMarket,
            },
          },
        });
        if (!wallet) {
          throw new DomainException(
            ErrorCode.WALLET_NOT_FOUND,
            `Wallet not found for ${lock.assetSymbol}`,
          );
        }

        // 원자적 조건부 차감 — check-then-update는 동시 주문에서 초과 인출 가능
        const debit = await tx.wallet.updateMany({
          where: {
            userId,
            assetSymbol: lock.assetSymbol,
            marketType: dto.tickerMarket,
            balance: { gte: lock.amount },
          },
          data: {
            balance: { decrement: lock.amount },
            locked: { increment: lock.amount },
          },
        });
        if (debit.count === 0) {
          throw new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');
        }

        const updatedWallet = await tx.wallet.findUnique({
          where: {
            userId_assetSymbol_marketType: {
              userId,
              assetSymbol: lock.assetSymbol,
              marketType: dto.tickerMarket,
            },
          },
        });
        if (!updatedWallet) {
          throw new Error(`wallet row vanished after debit (${userId}/${lock.assetSymbol})`);
        }

        const order = await tx.order.create({
          data: {
            userId,
            clientOrderId,
            tickerSymbol: dto.tickerSymbol,
            tickerMarket: dto.tickerMarket,
            type: dto.type,
            side: dto.side,
            timeInForce: dto.timeInForce,
            price,
            stopPrice,
            origQty,
            origQuoteQty,
            status: 'NEW',
          },
        });

        return { order, wallet: updatedWallet };
      }),
    );

    // stop 계열은 엔진 미전송 — 트리거까지 BE 보관
    if (isStopType(dto.type)) {
      this.registry.add(created.order);
    }

    this.userStream.emitAccountPosition(userId, [
      {
        asset: created.wallet.assetSymbol,
        free: created.wallet.balance.toFixed(8),
        locked: created.wallet.locked.toFixed(8),
        ts: created.wallet.updatedAt.getTime(),
      },
    ]);
    this.userStream.emitExecutionReport(
      userId,
      buildExecutionReport(created.order, meta, {
        executedQty: ZERO,
        cumulativeQuoteQty: ZERO,
        status: 'NEW',
        ts: created.order.createdAt.getTime(),
      }),
    );

    if (!isStopType(dto.type)) {
      await this.dispatch.dispatchNewOrder(created.order);
    }
    return created.order;
  }

  // ---------- cancel ----------

  /**
   * 단일 주문 취소 (OCO 레그 제외 — 호출 전 라우팅).
   * 미트리거 stop은 guarded 로컬 취소 + 환불, 그 외는 엔진 CO.
   */
  private async cancelSingle(order: Order): Promise<Order> {
    if (order.stopPrice !== null && order.triggeredAt === null) {
      const meta = this.tickerStats.metaOf(order.tickerMarket, order.tickerSymbol);
      if (!meta)
        throw new DomainException(
          ErrorCode.TICKER_NOT_FOUND,
          'Ticker not found',
          HttpStatus.NOT_FOUND,
        );

      // claim + 환불 INSERT를 한 트랜잭션으로 — 둘 사이 크래시 시 환불 유실 방지
      const claimed = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.order.updateMany({
          where: { id: order.id, status: 'NEW', triggeredAt: null },
          data: { status: 'CANCELED' },
        });
        if (claim.count !== 1) return false;
        if (order.orderListId === null) {
          await this.settlement.recordDustRefund(
            {
              orderId: order.id,
              userId: order.userId,
              market: order.tickerMarket,
              baseAssetSymbol: meta.baseAsset,
              quoteAssetSymbol: meta.quoteAsset,
              type: order.type,
              side: order.side,
              price: order.price,
              origQty: order.origQty,
              origQuoteQty: order.origQuoteQty,
              cumulativeQuoteQty: ZERO,
              executedQty: ZERO,
            },
            tx,
          );
        }
        return true;
      });
      if (claimed) {
        this.registry.remove(order.id);
        const canceled: Order = { ...order, status: 'CANCELED' };
        this.userStream.emitExecutionReport(
          order.userId,
          buildExecutionReport(canceled, meta, {
            executedQty: ZERO,
            cumulativeQuoteQty: ZERO,
            status: 'CANCELED',
            ts: Date.now(),
          }),
        );
        return canceled;
      }
      // claim 0: 이미 트리거됨 (엔진 거주) — 일반 CO 경로로 진행
    }

    await this.dispatch.dispatchCancelOrder(order);
    return order;
  }

  // ---------- helpers ----------

  private async lastPriceOf(market: MarketType, symbol: string): Promise<Decimal | null> {
    const snap = this.tickerStats.snapshotOne(market, symbol);
    if (snap?.lastPrice) return new Decimal(snap.lastPrice);
    const t = await this.prisma.trade.findFirst({
      where: { tickerSymbol: symbol, tickerMarket: market },
      orderBy: { seq: 'desc' },
      select: { price: true },
    });
    return t?.price ?? null;
  }
}
