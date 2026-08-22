import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  BalanceJournal,
  BalanceJournalKind,
  MarketType,
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
  Prisma,
  TimeInForce,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { JournalWriter, SourceKey } from '@app/core-domain/ledger/journal-writer';
import { LedgerService } from '@app/core-domain/ledger/ledger.service';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';
import { LEDGER_TRUTH } from '@app/core-domain/ledger/ledger-truth';
import { toEntry } from '@app/core-domain/ledger/journal-tailer';
import { assumingPrice, orderCost, priceBandCheck } from '../math/margin-math';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

const ZERO = new Decimal(0);

/** createOrder 내부 신호 — 조건부 차감이 0건. 원인(지갑 부재/잔고 부족) 판별은 tx 밖에서. */
class DebitRejected extends Error {}

export interface OrderDraft {
  userId: string;
  clientOrderId: string;
  symbol: string;
  type: OrderType;
  side: OrderSide;
  timeInForce: TimeInForce;
  price: Decimal | null; // MARKET은 null
  qty: Decimal;
  reduceOnly: boolean;
  cost: Decimal; // 잠글 금액. reduceOnly는 0
  lockAssetSymbol: string; // ticker quote (USDT)
}

/** 접수단 마진: 접수가/cost 산정 + 잔고 잠금 + Order insert. NO/CO 발행은 호출자 몫. */
@Injectable()
export class MarginService {
  private readonly logger = new Logger(MarginService.name);

  constructor(
    private prisma: PrismaService,
    private journalWriter: JournalWriter,
    private ledger: LedgerService,
    private availability: LedgerAvailability,
  ) {}

  /** S2 진실 경로 판정: 스위치 ON + 저널 가용(테이블 부재면 S0 행 경로로 안전 강등). */
  private useTruth(): boolean {
    return LEDGER_TRUTH && this.availability.enabled;
  }

  /**
   * 커밋된 저널 엔트리를 인메모리 원장에 멱등 반영 (테일러가 백스톱). S0에선 Wallet 변이 미러링,
   * S2에선 이미 reserve로 선반영된 place-lock은 no-op(seen). 강등 시 writeInTx가 null이라 no-op.
   * 반영 실패는 삼키되 소리내어 기록(거래 경로 무영향).
   */
  private reflect(row: BalanceJournal | null): void {
    if (!row) return;
    try {
      this.ledger.applyJournal(toEntry(row));
    } catch (e) {
      this.logger.error(`ledger reflect failed ${row.sourceKey}`, e as Error);
    }
  }

  /** 접수가: MARKET은 buffer 가정가, limit-like는 가격 밴드 검증 후 주문가. */
  admissionPriceOf(params: {
    type: OrderType;
    side: OrderSide;
    price: Decimal | null;
    mark: Decimal;
    priceBandPct: Decimal;
    marketCostBufferPct: Decimal;
  }): Decimal {
    if (params.type === OrderType.MARKET) {
      return assumingPrice(params.mark, params.side, params.marketCostBufferPct);
    }
    if (params.price === null) {
      throw new DomainException(ErrorCode.INVALID_ORDER_FIELDS, `${params.type} requires price`);
    }
    if (!priceBandCheck(params.price, params.mark, params.priceBandPct)) {
      throw new DomainException(
        ErrorCode.PRICE_OUT_OF_BAND,
        `price must be within ±${params.priceBandPct.mul(100).toFixed(2)}% of mark price ${params.mark.toFixed(8)}`,
      );
    }
    return params.price;
  }

  /** lockedCost = IM + openLoss + taker 수수료 예약. price에는 접수가를 넣는다. */
  costOf(params: {
    side: OrderSide;
    admissionPrice: Decimal;
    mark: Decimal;
    qty: Decimal;
    leverage: number;
    takerFeeBps: number;
  }): Decimal {
    return orderCost({
      side: params.side,
      price: params.admissionPrice,
      mark: params.mark,
      qty: params.qty,
      leverage: params.leverage,
      takerFeeBps: params.takerFeeBps,
    });
  }

  /** cost 조건부 차감-잠금 + Order insert를 한 트랜잭션으로. reduceOnly(cost 0)는 잠금 없음. */
  async createOrder(draft: OrderDraft): Promise<Order> {
    // cost 0이 일반 주문으로 새면 무담보 주문 — 불변식으로 차단
    if (draft.reduceOnly !== draft.cost.isZero()) {
      throw new Error('order cost must be zero iff reduceOnly');
    }

    const data = {
      userId: draft.userId,
      clientOrderId: draft.clientOrderId,
      tickerSymbol: draft.symbol,
      tickerMarket: MarketType.FUTURES,
      type: draft.type,
      side: draft.side,
      timeInForce: draft.timeInForce,
      price: draft.price,
      origQty: draft.qty, // 선물은 base-driven 고정 — origQuoteQty 미사용
      reduceOnly: draft.reduceOnly,
      lockedCost: draft.cost,
      status: OrderStatus.NEW,
    };

    if (draft.cost.isZero()) {
      return this.prisma.order.create({ data });
    }

    if (this.useTruth()) {
      return this.createOrderWithLedger(draft, data);
    }

    try {
      const { order, journal } = await this.prisma.$transaction(async (tx) => {
        // 주문 먼저 기록 — wallet 행 락은 아래 조건부 차감(마지막 stmt)에서만 잡아 commit까지 최소 보유.
        // (락 홀드 중 커넥션 점유가 풀 고갈로 번지는 컨보이 차단.) 차감 실패 시 tx 롤백으로 주문도 소멸.
        const order = await tx.order.create({ data });

        // 원자적 조건부 차감 — check-then-update는 동시 주문에서 초과 인출 가능
        const debit = await tx.wallet.updateMany({
          where: {
            userId: draft.userId,
            assetSymbol: draft.lockAssetSymbol,
            marketType: MarketType.FUTURES,
            balance: { gte: draft.cost },
          },
          data: {
            balance: { decrement: draft.cost },
            locked: { increment: draft.cost },
          },
        });
        if (debit.count === 0) {
          // 지갑 부재 vs 잔고 부족 판별은 락 보유 tx 밖으로 — 실패 경로만 SELECT (핫패스 왕복 제거)
          throw new DebitRejected();
        }

        // S0: 위 wallet 변이(balance→locked)를 같은 tx에 저널링 — 델타 동일, Order INSERT와 원자 결합
        const journal = await this.journalWriter.writeInTx(tx, {
          userId: draft.userId,
          assetSymbol: draft.lockAssetSymbol,
          marketType: MarketType.FUTURES,
          kind: BalanceJournalKind.FUTURES_PLACE_LOCK,
          deltaBalance: draft.cost.neg(),
          deltaLocked: draft.cost,
          sourceKey: SourceKey.futuresPlaceLock(order.id),
          meta: { orderId: order.id, symbol: draft.symbol },
        });

        return { order, journal };
      });
      this.reflect(journal);
      return order;
    } catch (e) {
      if (e instanceof DebitRejected) {
        throw await this.debitRejectionError(draft.userId, draft.lockAssetSymbol);
      }
      throw e;
    }
  }

  /**
   * S2 진실 경로: 잠금을 ledger.reserve()(동기 체크+홀드)로 선행 → 성공 시 tx = Order INSERT + 저널
   * INSERT만(Wallet 행 UPDATE 없음) → tx 실패 시 rollbackReserve. reserve가 곧 잔고 판정이라 부족 시
   * INSUFFICIENT_BALANCE (원장은 지갑 행 존재 개념이 없어 S2에선 WALLET_NOT_FOUND 구분 없음).
   */
  private async createOrderWithLedger(
    draft: OrderDraft,
    data: Prisma.OrderUncheckedCreateInput,
  ): Promise<Order> {
    const parts = {
      userId: draft.userId,
      assetSymbol: draft.lockAssetSymbol,
      marketType: MarketType.FUTURES,
    };
    const orderId = randomUUID();
    const sourceKey = SourceKey.futuresPlaceLock(orderId);
    if (!this.ledger.reserve(parts, draft.cost, sourceKey)) {
      throw new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const order = await tx.order.create({ data: { ...data, id: orderId } });
        await this.journalWriter.writeInTx(tx, {
          userId: draft.userId,
          assetSymbol: draft.lockAssetSymbol,
          marketType: MarketType.FUTURES,
          kind: BalanceJournalKind.FUTURES_PLACE_LOCK,
          deltaBalance: draft.cost.neg(),
          deltaLocked: draft.cost,
          sourceKey,
          meta: { orderId, symbol: draft.symbol },
        });
        return order;
      });
    } catch (e) {
      this.ledger.rollbackReserve(parts, draft.cost, sourceKey);
      throw e;
    }
  }

  /** 조건부 차감 0건의 원인 판별: 지갑 부재면 WALLET_NOT_FOUND, 있으면 INSUFFICIENT_BALANCE. */
  private async debitRejectionError(
    userId: string,
    assetSymbol: string,
  ): Promise<DomainException> {
    const wallet = await this.prisma.wallet.findUnique({
      where: {
        userId_assetSymbol_marketType: { userId, assetSymbol, marketType: MarketType.FUTURES },
      },
      select: { userId: true },
    });
    if (!wallet) {
      return new DomainException(ErrorCode.WALLET_NOT_FOUND, `Wallet not found for ${assetSymbol}`);
    }
    return new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');
  }

  /**
   * 미트리거 stop 주문 insert — 잠금/dispatch 없이 NEW(triggeredAt=null).
   * cost는 발화 시 armTriggeredStop이 잠근다 (접수 시 무잠금).
   */
  async createStopOrder(draft: {
    userId: string;
    clientOrderId: string;
    symbol: string;
    type: OrderType;
    side: OrderSide;
    timeInForce: TimeInForce;
    price: Decimal | null; // *_LIMIT만 값, 그 외 null
    stopPrice: Decimal;
    qty: Decimal;
    reduceOnly: boolean;
  }): Promise<Order> {
    return this.prisma.order.create({
      data: {
        userId: draft.userId,
        clientOrderId: draft.clientOrderId,
        tickerSymbol: draft.symbol,
        tickerMarket: MarketType.FUTURES,
        type: draft.type,
        side: draft.side,
        timeInForce: draft.timeInForce,
        price: draft.price,
        stopPrice: draft.stopPrice,
        origQty: draft.qty,
        reduceOnly: draft.reduceOnly,
        lockedCost: ZERO,
        status: OrderStatus.NEW,
      },
    });
  }

  /**
   * 트리거 발화: 조건부 잠금 + guarded claim(triggeredAt)을 한 트랜잭션으로.
   * 'fired'=무장+잠금 완료(dispatch 필요), 'lost'=취소 선점, 'insufficient'=잔고 부족(거부 필요).
   */
  async armTriggeredStop(params: {
    orderId: string;
    userId: string;
    lockAssetSymbol: string;
    cost: Decimal; // reduceOnly면 0
  }): Promise<'fired' | 'lost' | 'insufficient'> {
    const useTruth = this.useTruth();
    const parts = {
      userId: params.userId,
      assetSymbol: params.lockAssetSymbol,
      marketType: MarketType.FUTURES,
    };
    const lockKey = SourceKey.futuresPlaceLock(params.orderId);

    // S2: 발화 동결을 tx 전 동기 reserve로 선행 — 부족 시 즉시 거부(tx 미진입).
    if (useTruth && !params.cost.isZero()) {
      if (!this.ledger.reserve(parts, params.cost, lockKey)) return 'insufficient';
    }

    try {
      const { result, lockRow, unlockRow } = await this.prisma.$transaction(async (tx) => {
        let lockRow: BalanceJournal | null = null;
        let unlockRow: BalanceJournal | null = null;
        if (!params.cost.isZero()) {
          if (!useTruth) {
            const debit = await tx.wallet.updateMany({
              where: {
                userId: params.userId,
                assetSymbol: params.lockAssetSymbol,
                marketType: MarketType.FUTURES,
                balance: { gte: params.cost },
              },
              data: {
                balance: { decrement: params.cost },
                locked: { increment: params.cost },
              },
            });
            if (debit.count === 0) return { result: 'insufficient' as const, lockRow, unlockRow };
          }
          // 발화 동결(balance→locked) 저널 (S2 sourceKey는 reserve가 이미 선점한 lockKey)
          lockRow = await this.journalWriter.writeInTx(tx, {
            userId: params.userId,
            assetSymbol: params.lockAssetSymbol,
            marketType: MarketType.FUTURES,
            kind: BalanceJournalKind.FUTURES_PLACE_LOCK,
            deltaBalance: params.cost.neg(),
            deltaLocked: params.cost,
            sourceKey: lockKey,
            meta: { orderId: params.orderId, trigger: true },
          });
        }

        const claim = await tx.order.updateMany({
          where: { id: params.orderId, status: OrderStatus.NEW, triggeredAt: null },
          data: { triggeredAt: new Date(), lockedCost: params.cost },
        });
        if (claim.count === 0) {
          // 취소가 선점 — 방금 잠근 cost 보상. S2는 원장 leg를 저널만(Wallet 행 UPDATE 없음).
          if (!params.cost.isZero()) {
            if (!useTruth) {
              await tx.wallet.updateMany({
                where: {
                  userId: params.userId,
                  assetSymbol: params.lockAssetSymbol,
                  marketType: MarketType.FUTURES,
                },
                data: {
                  balance: { increment: params.cost },
                  locked: { decrement: params.cost },
                },
              });
            }
            // 보상 해제(locked→balance) 저널 — 발화 lock과 대칭, 별도 sourceKey
            unlockRow = await this.journalWriter.writeInTx(tx, {
              userId: params.userId,
              assetSymbol: params.lockAssetSymbol,
              marketType: MarketType.FUTURES,
              kind: BalanceJournalKind.FUTURES_PLACE_UNLOCK,
              deltaBalance: params.cost,
              deltaLocked: params.cost.neg(),
              sourceKey: `unlock:${params.orderId}`,
              meta: { orderId: params.orderId, reason: 'arm-cancel-preempted' },
            });
          }
          return { result: 'lost' as const, lockRow, unlockRow };
        }
        return { result: 'fired' as const, lockRow, unlockRow };
      });

      // 원장 반영: S2는 lock을 reserve로 이미 선반영(seen)했으니 lockRow는 no-op이라 unlock만 반영.
      if (useTruth) {
        if (unlockRow) this.reflect(unlockRow);
      } else {
        if (lockRow) this.reflect(lockRow);
        if (unlockRow) this.reflect(unlockRow);
      }
      return result;
    } catch (e) {
      if (useTruth && !params.cost.isZero()) {
        this.ledger.rollbackReserve(parts, params.cost, lockKey);
      }
      throw e;
    }
  }
}
