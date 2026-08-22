import { Injectable, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BalanceJournalKind, MarketType, Order, OrderStatus, Prisma, Wallet } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { JournalWriter, SourceKey } from '@app/core-domain/ledger/journal-writer';
import { LedgerService } from '@app/core-domain/ledger/ledger.service';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';
import { LEDGER_TRUTH } from '@app/core-domain/ledger/ledger-truth';
import { toEntry } from '@app/core-domain/ledger/journal-tailer';
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
import {
  MAX_OPEN_ORDERS_PER_SYMBOL,
  MM_MAX_OPEN_ORDERS_PER_SYMBOL,
} from '@app/shared/constants/trading-protection';

const OPEN_STATUSES: OrderStatus[] = ['NEW', 'OPEN', 'PARTIAL'];
const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);

const ZERO = new Decimal(0);
const MAX_HISTORY_LIMIT = 500;

// place tx 안에서 조건부 차감이 0건일 때 롤백 유발용 sentinel. tx 밖에서 원인(지갑부재 vs 잔고부족)을 판별.
class DebitFailedError extends Error {}

export interface ReplaceOrderResult {
  order: Order;
  replaced: { orderId: string; cancelRequested: true };
}

interface AccountPosition {
  asset: string;
  free: string;
  locked: string;
  ts: number;
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
    private journal: JournalWriter,
    private ledger: LedgerService,
    private availability: LedgerAvailability,
  ) {}

  /** S2 진실 경로 판정: 스위치 ON + 저널 가용(테이블 부재면 S0 행 경로로 안전 강등). */
  private useTruth(): boolean {
    return LEDGER_TRUTH && this.availability.enabled;
  }

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

    // 심볼별 오픈주문 상한 (soft — 동시 placement 레이스는 허용). replace는 교체 대상 제외.
    await this.assertUnderOrderCap(
      userId,
      dto.tickerMarket,
      dto.tickerSymbol,
      dto.replacesOrderId,
    );

    // 가격 밴드 기준가 = 5m 가중평균(있으면), 없으면 last. 둘 다 없으면 밴드 검사 생략.
    const avg = this.tickerStats.avgPrice5m(dto.tickerMarket, dto.tickerSymbol);
    const bandRefPrice = avg !== null ? new Decimal(avg) : last;

    validateAgainstMeta({
      type: dto.type,
      side: dto.side,
      price,
      stopPrice,
      origQty,
      origQuoteQty,
      meta,
      lastPrice: last,
      bandRefPrice,
    });

    const lock = lockFor({ type: dto.type, side: dto.side, price, origQty, origQuoteQty, meta });
    const clientOrderId = dto.newClientOrderId ?? generateClientOrderId();

    const amount = lock.amount.toFixed();
    const { order, accountPosition } = this.useTruth()
      ? await this.placeWithLedger(userId, dto, lock, clientOrderId, price, stopPrice, origQty, origQuoteQty)
      : await this.placeWithWallet(userId, dto, lock, clientOrderId, price, stopPrice, origQty, origQuoteQty, amount);

    // stop 계열은 엔진 미전송 — 트리거까지 BE 보관
    if (isStopType(dto.type)) {
      this.registry.add(order);
    }

    this.userStream.emitAccountPosition(userId, [accountPosition]);
    this.userStream.emitExecutionReport(
      userId,
      buildExecutionReport(order, meta, {
        executedQty: ZERO,
        cumulativeQuoteQty: ZERO,
        status: 'NEW',
        ts: order.createdAt.getTime(),
      }),
    );

    if (!isStopType(dto.type)) {
      await this.dispatch.dispatchNewOrder(order);
    }
    return order;
  }

  /**
   * S2 진실 경로: 동결을 ledger.reserve()(동기 체크+홀드)로 선행 → 성공 시 tx = Order INSERT + 저널
   * INSERT만(Wallet 행 UPDATE 없음 — 락 컨보이 소멸) → tx 실패 시 rollbackReserve. reserve가 곧 잔고
   * 판정이라 부족 시 INSUFFICIENT_BALANCE. outboundAccountPosition은 reserve 직후 원장 스냅샷에서 소싱.
   */
  private async placeWithLedger(
    userId: string,
    dto: CreateOrderDto,
    lock: { assetSymbol: string; amount: Decimal },
    clientOrderId: string,
    price: Decimal | null,
    stopPrice: Decimal | null,
    origQty: Decimal | null,
    origQuoteQty: Decimal | null,
  ): Promise<{ order: Order; accountPosition: AccountPosition }> {
    const parts = { userId, assetSymbol: lock.assetSymbol, marketType: dto.tickerMarket };
    const orderId = randomUUID();
    const sourceKey = SourceKey.spotPlaceLock(orderId);
    // 동기 체크+홀드 — check와 hold 사이 yield 없음 → 동시 접수 초과 인출 불가.
    if (!this.ledger.reserve(parts, lock.amount, sourceKey)) {
      throw new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');
    }
    let order: Order;
    try {
      order = await createOrderOrThrowDuplicate(async () => {
        // 2개 INSERT뿐 — 인터랙티브 tx(AsyncLocalStorage 오버헤드) 대신 batch $transaction([...]).
        // orderId를 미리 생성했으므로 저널이 주문 id를 결과에서 받을 필요 없음(둘 다 pre-gen 참조).
        const orderOp = this.prisma.order.create({
          data: {
            id: orderId,
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
        const journalOp = this.journal.createInBatch({
          userId,
          assetSymbol: lock.assetSymbol,
          marketType: dto.tickerMarket,
          kind: BalanceJournalKind.SPOT_PLACE_LOCK,
          deltaBalance: lock.amount.neg(),
          deltaLocked: lock.amount,
          sourceKey,
          meta: { orderId, clientOrderId },
        });
        // 강등 시 journalOp=null → 주문만 원자 커밋 (writeInTx null 시맨틱과 동일).
        const ops: Prisma.PrismaPromise<unknown>[] = [orderOp];
        if (journalOp) ops.push(journalOp);
        const [created] = await this.prisma.$transaction(ops);
        return created as Order;
      });
    } catch (e) {
      this.ledger.rollbackReserve(parts, lock.amount, sourceKey);
      throw e;
    }
    // reserve 직후 원장 스냅샷 (tx 밖, 진실 값). ts는 주문 생성 시각.
    const snap = this.ledger.getDecimal(parts);
    return {
      order,
      accountPosition: {
        asset: lock.assetSymbol,
        free: snap.balance.toFixed(8),
        locked: snap.locked.toFixed(8),
        ts: order.createdAt.getTime(),
      },
    };
  }

  /**
   * S0 경로 (LEDGER_TRUTH=false 또는 저널 강등): order.create 먼저(실패 시 롤백 소멸) → 원자적 조건부
   * 차감+RETURNING 한 방. 차감 0건은 sentinel로 롤백 후 tx 밖에서 원인(지갑부재 vs 잔고부족)만 별도 조회로 판별.
   */
  private async placeWithWallet(
    userId: string,
    dto: CreateOrderDto,
    lock: { assetSymbol: string; amount: Decimal },
    clientOrderId: string,
    price: Decimal | null,
    stopPrice: Decimal | null,
    origQty: Decimal | null,
    origQuoteQty: Decimal | null,
    amount: string,
  ): Promise<{ order: Order; accountPosition: AccountPosition }> {
    const created = await createOrderOrThrowDuplicate(async () => {
      try {
        return await this.prisma.$transaction(async (tx) => {
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

          // 원자적 조건부 차감 — check-then-update는 동시 주문에서 초과 인출 가능.
          // updatedAt는 raw가 @updatedAt를 건너뛰므로 NOW()로 직접 갱신(유저스트림 ts 보존).
          const debited = await tx.$queryRaw<Wallet[]>`
            UPDATE "Wallet"
               SET "balance" = "balance" - ${amount}::numeric,
                   "locked" = "locked" + ${amount}::numeric,
                   "updatedAt" = NOW()
             WHERE "userId" = ${userId}
               AND "assetSymbol" = ${lock.assetSymbol}
               AND "marketType" = ${dto.tickerMarket}::"MarketType"
               AND "balance" >= ${amount}::numeric
            RETURNING *`;
          if (debited.length === 0) {
            throw new DebitFailedError();
          }

          // S0 원장 섀도: 동결을 wallet 변이와 동일 델타로 저널에 병행 기록 (Order INSERT와 원자 결합).
          const journalRow = await this.journal.writeInTx(tx, {
            userId,
            assetSymbol: lock.assetSymbol,
            marketType: dto.tickerMarket,
            kind: BalanceJournalKind.SPOT_PLACE_LOCK,
            deltaBalance: lock.amount.neg(),
            deltaLocked: lock.amount,
            sourceKey: SourceKey.spotPlaceLock(order.id),
            meta: { orderId: order.id, clientOrderId },
          });

          return { order, wallet: debited[0], journalRow };
        });
      } catch (e) {
        if (e instanceof DebitFailedError) {
          // 롤백됨(order.create 소멸). 원인 판별만 tx 밖 단발 조회로.
          const w = await this.prisma.wallet.findUnique({
            where: {
              userId_assetSymbol_marketType: {
                userId,
                assetSymbol: lock.assetSymbol,
                marketType: dto.tickerMarket,
              },
            },
          });
          if (!w) {
            throw new DomainException(
              ErrorCode.WALLET_NOT_FOUND,
              `Wallet not found for ${lock.assetSymbol}`,
            );
          }
          throw new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');
        }
        throw e;
      }
    });

    // 커밋 후 자기 마켓 엔트리 즉시 로컬 반영 (멱등 — tailer 재수신은 sourceKey로 no-op).
    // journalRow null = 원장 강등(LedgerAvailability disabled) → 저널 미기록이므로 로컬 반영도 skip.
    if (created.journalRow && this.ledger.owns(dto.tickerMarket)) {
      this.ledger.applyJournal(toEntry(created.journalRow));
    }

    return {
      order: created.order,
      accountPosition: {
        asset: created.wallet.assetSymbol,
        free: created.wallet.balance.toFixed(8),
        locked: created.wallet.locked.toFixed(8),
        ts: created.wallet.updatedAt.getTime(),
      },
    };
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

  /** 오픈주문 상한 검사. excludeOrderId(cancel-replace 대상)는 카운트에서 제외. */
  private async assertUnderOrderCap(
    userId: string,
    market: MarketType,
    symbol: string,
    excludeOrderId?: string,
  ): Promise<void> {
    const count = await this.prisma.order.count({
      where: {
        userId,
        tickerSymbol: symbol,
        tickerMarket: market,
        status: { in: OPEN_STATUSES },
        ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
      },
    });
    if (count < MAX_OPEN_ORDERS_PER_SYMBOL) return;
    // 일반 상한 도달 시에만 유저 조회 — 시장조성 계정(rateLimitExempt)은 상향 캡 (ADR-068)
    const cap = (await this.isMarketMaker(userId))
      ? MM_MAX_OPEN_ORDERS_PER_SYMBOL
      : MAX_OPEN_ORDERS_PER_SYMBOL;
    if (count >= cap) {
      throw new DomainException(
        ErrorCode.MAX_NUM_ORDERS_EXCEEDED,
        `Open-order limit reached for ${symbol} (max ${cap})`,
      );
    }
  }

  private async isMarketMaker(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { rateLimitExempt: true },
    });
    return user?.rateLimitExempt ?? false;
  }

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
