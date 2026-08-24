import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  BalanceJournal,
  BalanceJournalKind,
  FuturesIncomeType,
  MarginMode,
  MarketType,
  Order,
  OrderSide,
  OrderStatus,
  PositionStatus,
  Prisma,
  SettlementEvent,
  SettlementKind,
  SettlementStatus,
  Wallet,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { KafkaService } from '@app/infra/messaging/kafka.service';
import { inboundTopic } from '@app/infra/messaging/topics';
import { serializeCancelOrder } from '@app/infra/messaging/match-message.serializer';
import { JournalWriter, SourceKey } from '@app/core-domain/ledger/journal-writer';
import { LedgerService } from '@app/core-domain/ledger/ledger.service';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';
import { LEDGER_TRUTH } from '@app/core-domain/ledger/ledger-truth';
import { toEntry } from '@app/core-domain/ledger/journal-tailer';
import { JournalInput } from '@app/core-domain/ledger/ledger.types';
import { FuturesConfigService } from '../config/futures-config.service';
import { MARK_READER } from './mark-reader';
import type { MarkReader } from './mark-reader';
import {
  FuturesBalanceSnapshot,
  FuturesPositionSnapshot,
  FuturesUserEventsService,
} from '../user-events/futures-user-events.service';
import { floor8 } from '@app/shared/decimal';
import { SETTLEMENT_MAX_ATTEMPTS } from '@app/shared/constants/settlement';
import { bankruptcyPrice, liquidationPrice, unrealizedPnl } from '../math/margin-math';
import {
  applyFill,
  applyFundingPayment,
  Fill,
  fundingPayment,
  PositionState,
  refundAmount,
} from '../math/position-math';
import { InsuranceFundService } from './insurance-fund.service';
import {
  FuturesTradeLeg,
  parseFundingLegs,
  parseOrderLegs,
  parseRefundLeg,
  parseTakeoverLeg,
  parseTradeLeg,
} from './futures-settlement.types';

const BATCH_SIZE = 500;
const MARKET: MarketType = MarketType.FUTURES;
const USDT = 'USDT';
const ZERO = new Decimal(0);

const FUTURES_KINDS: SettlementKind[] = [
  SettlementKind.FUTURES_TRADE,
  SettlementKind.FUTURES_REFUND,
  SettlementKind.FUNDING,
  SettlementKind.LIQUIDATION_TAKEOVER,
];

const OPEN_STATUSES: OrderStatus[] = [OrderStatus.NEW, OrderStatus.OPEN, OrderStatus.PARTIAL];

interface PositionRow {
  qty: Decimal;
  entryPrice: Decimal;
  isolatedMargin: Decimal;
  leverage: number;
  status: PositionStatus;
}

interface WalletRow {
  balance: Decimal;
  locked: Decimal;
}

interface PositionRecord {
  userId: string;
  tickerSymbol: string;
  qty: Decimal;
  entryPrice: Decimal;
  isolatedMargin: Decimal;
  leverage: number;
  marginMode: MarginMode;
  status: PositionStatus;
  updatedAt: Date;
}

/** event 1건 commit 후 후처리 재료 — emit/CO/error 로그는 commit 이후에만. */
interface ApplyOutcome {
  walletByUser: Map<string, FuturesBalanceSnapshot>;
  positionByUser: Map<string, Map<string, FuturesPositionSnapshot>>;
  reduceOnlyChecks: Map<string, { userId: string; symbol: string }>;
  shortfallLogs: string[];
  journalRows: BalanceJournal[]; // 이 event tx에서 커밋된 저널 엔트리 (commit 후 원장 반영)
  affectedWalletUsers: Set<string>; // S2: wallet leg가 바뀐 유저 (commit 후 원장에서 스냅샷 합성)
}

function emptyOutcome(): ApplyOutcome {
  return {
    walletByUser: new Map(),
    positionByUser: new Map(),
    reduceOnlyChecks: new Map(),
    shortfallLogs: [],
    journalRows: [],
    affectedWalletUsers: new Set(),
  };
}

function opposite(side: OrderSide): OrderSide {
  return side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
}

/**
 * 기금 포지션 합산: flat/같은 부호는 EP 가중평균, 반대 부호는 net.
 * 상쇄분은 addEp에 청산된 것과 동치 — 실현손익을 반환해 기금 balance에 기록한다 (소멸 금지).
 */
function mergeFundPosition(
  curQty: Decimal,
  curEp: Decimal,
  addQty: Decimal,
  addEp: Decimal,
): { qty: Decimal; entryPrice: Decimal; realizedPnl: Decimal } {
  const newQty = curQty.add(addQty);
  if (curQty.isZero()) return { qty: newQty, entryPrice: addEp, realizedPnl: ZERO };
  if (curQty.isPositive() === addQty.isPositive()) {
    const entryPrice = floor8(
      curQty.abs().mul(curEp).add(addQty.abs().mul(addEp)).div(curQty.abs().add(addQty.abs())),
    );
    return { qty: newQty, entryPrice, realizedPnl: ZERO };
  }
  // RPNL = (addEp − curEp) × netted × sign(cur)
  const netted = Decimal.min(curQty.abs(), addQty.abs());
  const sign = curQty.isNegative() ? -1 : 1;
  const realizedPnl = floor8(addEp.sub(curEp).mul(netted).mul(sign));
  if (newQty.isZero()) return { qty: newQty, entryPrice: ZERO, realizedPnl };
  return {
    qty: newQty,
    entryPrice: newQty.isPositive() === curQty.isPositive() ? curEp : addEp,
    realizedPnl,
  };
}

/**
 * futures 정산 worker — PENDING futures 이벤트를 seq 순 직렬 적용 (consume insert 순 = 엔진 발행 순).
 * 포지션 의존 계산(EP/RPNL/마진)은 Position 행을 SELECT FOR UPDATE로 잠근 트랜잭션 안에서 수행.
 */
@Injectable()
export class FuturesSettlementWorker implements OnApplicationShutdown {
  private readonly logger = new Logger(FuturesSettlementWorker.name);
  private readonly partitions = new Map<string, number>();
  private readonly failCounts = new Map<string, number>(); // eventId → 연속 적용 실패 횟수 (ADR-067)
  private running = false;
  private stopping = false;

  /** 종료 시퀀스: 새 tick 차단 후 진행 중 tick의 tx가 끝날 때까지 대기 — 포지션 전이가 찢기지 않는다. */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    const deadline = Date.now() + 15_000;
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.running) this.logger.error('shutdown: futures settlement tick still running after 15s grace');
    else this.logger.log('futures settlement worker quiesced');
  }

  constructor(
    private prisma: PrismaService,
    private kafka: KafkaService,
    private futuresConfig: FuturesConfigService,
    private insuranceFund: InsuranceFundService,
    private userEvents: FuturesUserEventsService,
    @Inject(MARK_READER) private markPrice: MarkReader,
    private journalWriter: JournalWriter,
    private ledger: LedgerService,
    private availability: LedgerAvailability,
  ) {}

  /** S2 진실 경로 판정: 스위치 ON + 저널 가용(테이블 부재면 S0 행 경로로 안전 강등). */
  private useTruth(): boolean {
    return LEDGER_TRUTH && this.availability.enabled;
  }

  /** futures USDT 잔고 free (S2=원장 진실, S0=Wallet 행 FOR UPDATE) — flip/shortfall 판정 입력. */
  private async walletBalanceOf(tx: Prisma.TransactionClient, userId: string): Promise<Decimal> {
    if (this.useTruth()) {
      return this.ledger.getDecimal({ userId, assetSymbol: USDT, marketType: MARKET }).balance;
    }
    return (await this.lockWallet(tx, userId)).balance;
  }

  @Interval(100)
  async tick(): Promise<void> {
    if (this.running || this.stopping) return; // 이전 tick 처리 중 / 종료 시퀀스 중이면 skip
    this.running = true;
    try {
      await this.drain();
    } catch (e) {
      this.logger.error('futures settlement worker tick failed', e as Error);
    } finally {
      this.running = false;
    }
  }

  private async drain(): Promise<void> {
    const pending = await this.prisma.settlementEvent.findMany({
      where: { status: SettlementStatus.PENDING, kind: { in: FUTURES_KINDS } },
      // createdAt은 ms 동률에서 tie-break 불가(id는 uuid4) — seq가 유일한 결정적 순서
      orderBy: { seq: 'asc' },
      take: BATCH_SIZE,
    });

    for (const event of pending) {
      let outcome: ApplyOutcome;
      try {
        outcome = await this.apply(event);
      } catch (e) {
        // 포지션 전이는 순서가 정합성 조건 — 재시도 대상이면 건너뛰지 않고 중단, 다음 tick 재시도.
        // 반복 실패(poison)는 격리하고 후속 이벤트 진행 — 1건이 파이프라인을 정지시키지 않게 (ADR-067).
        const quarantined = await this.recordFailure(event, e as Error);
        if (quarantined) continue;
        break;
      }
      await this.postApply(outcome);
    }
  }

  /**
   * 실패 기록: 인메모리 attempts 증가(워커 재시작 시 리셋 — poison은 threshold를 다시 채우고
   * 격리됨), SETTLEMENT_MAX_ATTEMPTS 도달 시 격리 + DeadLetter 사본. 격리 여부 반환.
   * DLQ 스키마 미적용(settlement-dlq 마이그레이션 전)이면 격리를 강등하고 기존 재시도 동작 유지.
   */
  private async recordFailure(event: SettlementEvent, err: Error): Promise<boolean> {
    const attempts = (this.failCounts.get(event.id) ?? 0) + 1;
    this.failCounts.set(event.id, attempts);
    if (attempts < SETTLEMENT_MAX_ATTEMPTS) {
      this.logger.error(
        `failed to apply futures event ${event.id} (${event.kind}) — attempt ${attempts}/${SETTLEMENT_MAX_ATTEMPTS}, retrying`,
        err,
      );
      return false;
    }
    try {
      // 격리 — 상태 전이와 사본 기록을 한 트랜잭션으로. PENDING이 아니면(경합 처리됨) no-op.
      const quarantined = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.settlementEvent.updateMany({
          where: { id: event.id, status: SettlementStatus.PENDING },
          data: { status: SettlementStatus.QUARANTINED },
        });
        if (claim.count === 0) return false;
        await tx.settlementDeadLetter.create({
          data: {
            eventId: event.id,
            seq: event.seq,
            sourceKey: event.sourceKey,
            kind: event.kind,
            legs: event.legs as Prisma.InputJsonValue,
            orderLegs: event.orderLegs as Prisma.InputJsonValue,
            attempts,
            lastError: err.message,
          },
        });
        return true;
      });
      if (quarantined) {
        this.failCounts.delete(event.id);
        this.logger.error(
          `QUARANTINED futures settlement event ${event.id} (${event.kind}, seq=${event.seq}, ` +
            `sourceKey=${event.sourceKey}) after ${attempts} failed attempts — money movement NOT ` +
            `applied; see SettlementDeadLetter. lastError: ${err.message}`,
        );
      }
      return quarantined;
    } catch (dlqErr) {
      this.logger.error(
        `DLQ unavailable for event ${event.id} — run the settlement-dlq prisma migration; falling back to retry`,
        dlqErr as Error,
      );
      return false;
    }
  }

  /** event 1건을 단일 트랜잭션으로 적용. 실패 시 전체 롤백(PENDING 잔존). */
  private async apply(event: SettlementEvent): Promise<ApplyOutcome> {
    const outcome = emptyOutcome();

    await this.prisma.$transaction(async (tx) => {
      // race 방지: PENDING → APPLIED 전이가 0건이면 이미 처리됨
      const claim = await tx.settlementEvent.updateMany({
        where: { id: event.id, status: SettlementStatus.PENDING },
        data: { status: SettlementStatus.APPLIED, appliedAt: new Date() },
      });
      if (claim.count === 0) {
        throw new Error(`event ${event.id} already claimed`);
      }

      switch (event.kind) {
        case SettlementKind.FUTURES_TRADE:
          await this.applyTrade(tx, event, outcome);
          break;
        case SettlementKind.FUTURES_REFUND:
          await this.applyRefund(tx, event, outcome);
          break;
        case SettlementKind.FUNDING:
          await this.applyFunding(tx, event, outcome);
          break;
        case SettlementKind.LIQUIDATION_TAKEOVER:
          await this.applyTakeover(tx, event, outcome);
          break;
        default:
          throw new Error(`event ${event.id}: unexpected kind ${event.kind}`);
      }
    });

    return outcome;
  }

  // ---------- FUTURES_TRADE ----------

  private async applyTrade(
    tx: Prisma.TransactionClient,
    event: SettlementEvent,
    outcome: ApplyOutcome,
  ): Promise<void> {
    const leg = parseTradeLeg(event);
    const orderLegs = parseOrderLegs(event);

    await this.applyTradeSide(tx, event, leg, 'maker', outcome);
    await this.applyTradeSide(tx, event, leg, 'taker', outcome);

    for (const ol of orderLegs) {
      await tx.order.update({
        where: { id: ol.orderId },
        data: {
          executedQty: { increment: new Decimal(ol.executedQtyDelta) },
          cumulativeQuoteQty: { increment: new Decimal(ol.cumulativeQuoteQtyDelta) },
        },
      });
    }
  }

  private async applyTradeSide(
    tx: Prisma.TransactionClient,
    event: SettlementEvent,
    leg: FuturesTradeLeg,
    role: 'maker' | 'taker',
    outcome: ApplyOutcome,
  ): Promise<void> {
    const userId = role === 'maker' ? leg.makerUserId : leg.takerUserId;
    const orderId = role === 'maker' ? leg.makerOrderId : leg.takerOrderId;
    const side = role === 'taker' ? leg.takerSide : opposite(leg.takerSide);
    const feeBps = role === 'maker' ? leg.makerFeeBps : leg.takerFeeBps;

    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error(`trade ${event.sourceKey}: order ${orderId} not found`);
    if (order.origQty === null) {
      throw new Error(`trade ${event.sourceKey}: futures order ${orderId} has no origQty`);
    }

    const position = await this.lockPosition(tx, userId, leg.symbol);
    const walletBalance = await this.walletBalanceOf(tx, userId);

    const fill: Fill = {
      price: new Decimal(leg.price),
      qty: new Decimal(leg.qty),
      side,
      feeBps,
      lockedCost: order.lockedCost ?? ZERO,
      origQty: order.origQty,
      prevExecutedQty: order.executedQty,
      reduceOnly: order.reduceOnly,
      liquidation: order.liquidation,
      liquidationFeeRate: order.liquidation
        ? (await this.futuresConfig.configOf(leg.symbol)).liquidationFeeRate
        : undefined,
    };

    const state: PositionState = {
      qty: position.qty,
      entryPrice: position.entryPrice,
      isolatedMargin: position.isolatedMargin,
      leverage: position.leverage,
    };
    const result = applyFill(state, fill, { balance: walletBalance });

    const updatedPosition = await tx.position.update({
      where: { userId_tickerSymbol: { userId, tickerSymbol: leg.symbol } },
      data: {
        qty: result.newPosition.qty,
        entryPrice: result.newPosition.entryPrice,
        isolatedMargin: result.newPosition.isolatedMargin,
      },
    });
    // S2: Wallet 행 UPDATE 없음 — 저널이 진실, 커밋 후 원장 반영. S0: 행 변이(마진해제+PnL+수수료 합산).
    if (!this.useTruth()) {
      const updatedWallet = await tx.wallet.update({
        where: {
          userId_assetSymbol_marketType: { userId, assetSymbol: USDT, marketType: MARKET },
        },
        data: {
          balance: { increment: result.walletDeltas.balanceDelta },
          locked: { increment: result.walletDeltas.lockedDelta },
        },
      });
      this.recordWallet(outcome, updatedWallet);
    }
    outcome.affectedWalletUsers.add(userId);
    // wallet 변이(마진해제+PnL+수수료 합산) 1건 = 저널 1건, 분해는 meta에
    await this.journalLeg(
      tx,
      {
        userId,
        assetSymbol: USDT,
        marketType: MARKET,
        kind: BalanceJournalKind.FUTURES_TRADE,
        deltaBalance: result.walletDeltas.balanceDelta,
        deltaLocked: result.walletDeltas.lockedDelta,
        sourceKey: `${event.sourceKey}:${role}`,
        meta: {
          role,
          income: result.incomeRecords.map((r) => ({
            type: r.incomeType,
            amount: r.income.toString(),
          })),
        },
      },
      outcome,
    );

    for (const inc of result.incomeRecords) {
      await tx.futuresIncome.create({
        data: {
          userId,
          tickerSymbol: leg.symbol,
          incomeType: inc.incomeType,
          income: inc.income,
          sourceKey: `${event.sourceKey}:${role}:${inc.incomeType}`,
        },
      });
    }

    for (const ft of result.fundTransfers) {
      // `:fund` 접미 — 유저 income(`:LIQUIDATION_FEE`)과 sourceKey 충돌 방지 (@unique)
      await this.creditFund(
        tx,
        leg.symbol,
        ft.amount,
        `${event.sourceKey}:${role}:${ft.reason}:fund`,
        outcome,
      );
    }

    if (result.fundTakeover) {
      const t = result.fundTakeover;
      await tx.settlementEvent.create({
        data: {
          sourceKey: `ftakeover:${event.sourceKey}:${role}`,
          kind: SettlementKind.LIQUIDATION_TAKEOVER,
          legs: [
            {
              userId,
              symbol: leg.symbol,
              qty: t.qty.toString(),
              entryPrice: t.entryPrice.toString(),
              margin: t.margin.toString(),
            },
          ] as unknown as Prisma.InputJsonValue,
          orderLegs: [] as unknown as Prisma.InputJsonValue,
        },
      });
    }

    for (const sf of result.shortfalls) {
      outcome.shortfallLogs.push(
        `trade ${event.sourceKey} ${role} user=${userId} ${leg.symbol}: ${sf.reason} amount=${sf.amount.toFixed(8)}`,
      );
    }

    this.recordPosition(outcome, updatedPosition);
    outcome.reduceOnlyChecks.set(`${userId}:${leg.symbol}`, { userId, symbol: leg.symbol });
  }

  // ---------- FUTURES_REFUND ----------

  private async applyRefund(
    tx: Prisma.TransactionClient,
    event: SettlementEvent,
    outcome: ApplyOutcome,
  ): Promise<void> {
    const leg = parseRefundLeg(event);
    const order = await tx.order.findUnique({ where: { id: leg.orderId } });
    if (!order) throw new Error(`refund ${event.sourceKey}: order ${leg.orderId} not found`);
    if (order.origQty === null) {
      throw new Error(`refund ${event.sourceKey}: futures order ${leg.orderId} has no origQty`);
    }

    const refund = refundAmount(
      order.lockedCost ?? ZERO,
      order.origQty,
      new Decimal(leg.finalExecutedQty),
    );
    if (refund.lte(0)) return;

    // S2: Wallet 행 UPDATE 없음 — 저널이 진실. S0: locked→balance 행 환불.
    if (!this.useTruth()) {
      const wallet = await tx.wallet.update({
        where: {
          userId_assetSymbol_marketType: {
            userId: leg.userId,
            assetSymbol: USDT,
            marketType: MARKET,
          },
        },
        data: { locked: { decrement: refund }, balance: { increment: refund } },
      });
      this.recordWallet(outcome, wallet);
    }
    outcome.affectedWalletUsers.add(leg.userId);
    // 미체결 lockedCost 환불(locked→balance) 저널
    await this.journalLeg(
      tx,
      {
        userId: leg.userId,
        assetSymbol: USDT,
        marketType: MARKET,
        kind: BalanceJournalKind.FUTURES_REFUND,
        deltaBalance: refund,
        deltaLocked: refund.neg(),
        sourceKey: SourceKey.futuresRefund(leg.orderId),
        meta: { orderId: leg.orderId, refund: refund.toString() },
      },
      outcome,
    );
  }

  // ---------- FUNDING ----------

  private async applyFunding(
    tx: Prisma.TransactionClient,
    event: SettlementEvent,
    outcome: ApplyOutcome,
  ): Promise<void> {
    const legs = parseFundingLegs(event);
    for (const leg of legs) {
      const payment = fundingPayment(
        new Decimal(leg.rate),
        new Decimal(leg.mark),
        new Decimal(leg.qty),
      );
      // 잠금 순서 Position→Wallet 통일 (trade apply/HTTP 경로와 교착 방지) — margin을 만질 수 있는 지불 측만
      if (payment.isNegative()) await this.lockPosition(tx, leg.userId, leg.symbol);
      const balance = await this.walletBalanceOf(tx, leg.userId);
      const application = applyFundingPayment(payment, balance);

      // S2: Wallet 행 UPDATE 없음 — 저널이 진실. S0: balance 행 반영.
      if (!this.useTruth()) {
        const updatedWallet = await tx.wallet.update({
          where: {
            userId_assetSymbol_marketType: {
              userId: leg.userId,
              assetSymbol: USDT,
              marketType: MARKET,
            },
          },
          data: { balance: { increment: application.balanceDelta } },
        });
        this.recordWallet(outcome, updatedWallet);
      }
      outcome.affectedWalletUsers.add(leg.userId);
      // 펀딩 wallet leg만 저널 (balance 부족분의 margin 흡수는 포지션 회계 — 불변, 무저널)
      await this.journalLeg(
        tx,
        {
          userId: leg.userId,
          assetSymbol: USDT,
          marketType: MARKET,
          kind: BalanceJournalKind.FUTURES_FUNDING,
          deltaBalance: application.balanceDelta,
          deltaLocked: ZERO,
          sourceKey: `${event.sourceKey}:${leg.userId}`,
          meta: { payment: payment.toString(), marginDelta: application.marginDelta.toString() },
        },
        outcome,
      );

      if (!application.marginDelta.isZero()) {
        // balance 부족분은 margin에서 — 음수 허용(zero-sum). 청산 판정은 모니터가 mark tick마다 수행.
        // Position 행은 위에서 이미 잠금 (marginDelta != 0 ⇒ payment < 0)
        const updatedPosition = await tx.position.update({
          where: { userId_tickerSymbol: { userId: leg.userId, tickerSymbol: leg.symbol } },
          data: { isolatedMargin: { increment: application.marginDelta } },
        });
        this.recordPosition(outcome, updatedPosition);
      }

      await tx.futuresIncome.create({
        data: {
          userId: leg.userId,
          tickerSymbol: leg.symbol,
          incomeType: FuturesIncomeType.FUNDING_FEE,
          income: payment,
          sourceKey: `${event.sourceKey}:${leg.userId}`,
        },
      });
    }
  }

  // ---------- LIQUIDATION_TAKEOVER ----------

  private async applyTakeover(
    tx: Prisma.TransactionClient,
    event: SettlementEvent,
    outcome: ApplyOutcome,
  ): Promise<void> {
    const leg = parseTakeoverLeg(event);
    const fundUserId = await this.insuranceFund.userId();

    if (leg.qty !== undefined) {
      // flip IM 부족 인수 — 유저 포지션은 trade apply에서 이미 flat, 명시 내용만 기금에 합산
      const addQty = new Decimal(leg.qty);
      const addEp = new Decimal(leg.entryPrice!);
      const margin = new Decimal(leg.margin!);

      const fundPosition = await this.lockPosition(tx, fundUserId, leg.symbol);
      const merged = mergeFundPosition(fundPosition.qty, fundPosition.entryPrice, addQty, addEp);
      const updatedFund = await tx.position.update({
        where: { userId_tickerSymbol: { userId: fundUserId, tickerSymbol: leg.symbol } },
        data: {
          qty: merged.qty,
          entryPrice: merged.entryPrice,
          isolatedMargin: { increment: margin },
        },
      });
      this.recordPosition(outcome, updatedFund);

      await tx.futuresIncome.create({
        data: {
          userId: fundUserId,
          tickerSymbol: leg.symbol,
          incomeType: FuturesIncomeType.INSURANCE_CLEAR,
          income: margin,
          sourceKey: `${event.sourceKey}:fund`,
        },
      });
      if (!merged.realizedPnl.isZero()) {
        await this.creditFund(
          tx,
          leg.symbol,
          merged.realizedPnl,
          `${event.sourceKey}:fund:netting`,
          outcome,
        );
      }
      return;
    }

    // 청산 모니터 생산 — 유저 포지션 잔량을 BP로 인수, margin은 기금 balance로
    const position = await this.lockPosition(tx, leg.userId, leg.symbol);

    if (position.qty.isZero()) {
      // 인수 대상 없음 (이미 전량 체결) — 청산 상태만 해제
      const updated = await tx.position.update({
        where: { userId_tickerSymbol: { userId: leg.userId, tickerSymbol: leg.symbol } },
        data: { status: PositionStatus.NORMAL },
      });
      this.recordPosition(outcome, updated);
      return;
    }

    const bp = bankruptcyPrice(position.entryPrice, position.qty, position.isolatedMargin);
    const updatedUser = await tx.position.update({
      where: { userId_tickerSymbol: { userId: leg.userId, tickerSymbol: leg.symbol } },
      data: { qty: ZERO, entryPrice: ZERO, isolatedMargin: ZERO, status: PositionStatus.NORMAL },
    });
    this.recordPosition(outcome, updatedUser);

    const fundPosition = await this.lockPosition(tx, fundUserId, leg.symbol);
    const merged = mergeFundPosition(fundPosition.qty, fundPosition.entryPrice, position.qty, bp);
    const updatedFund = await tx.position.update({
      where: { userId_tickerSymbol: { userId: fundUserId, tickerSymbol: leg.symbol } },
      data: { qty: merged.qty, entryPrice: merged.entryPrice },
    });
    this.recordPosition(outcome, updatedFund);

    if (!merged.realizedPnl.isZero()) {
      await this.creditFund(
        tx,
        leg.symbol,
        merged.realizedPnl,
        `${event.sourceKey}:fund:netting`,
        outcome,
      );
    }
    if (!position.isolatedMargin.isZero()) {
      await this.creditFund(
        tx,
        leg.symbol,
        position.isolatedMargin,
        `${event.sourceKey}:fund`,
        outcome,
      );
    }
    outcome.reduceOnlyChecks.set(`${leg.userId}:${leg.symbol}`, {
      userId: leg.userId,
      symbol: leg.symbol,
    });
  }

  // ---------- 공통 ----------

  /**
   * S0: leg별 저널 write — 커밋된 wallet 변이를 미러링. 강등 시 writeInTx가 null(호출측 tx에 stmt
   * 미발행)이라 push 생략, 정산 tx 무영향. commit 후 postApply가 journalRows를 원장에 반영.
   */
  private async journalLeg(
    tx: Prisma.TransactionClient,
    input: JournalInput,
    outcome: ApplyOutcome,
  ): Promise<void> {
    const row = await this.journalWriter.writeInTx(tx, input);
    if (row) outcome.journalRows.push(row);
  }

  /** 기금 wallet 반영(signed — 상쇄 손실은 음수) + INSURANCE_CLEAR 원장. */
  private async creditFund(
    tx: Prisma.TransactionClient,
    symbol: string,
    amount: Decimal,
    sourceKey: string,
    outcome: ApplyOutcome,
  ): Promise<void> {
    const fundUserId = await this.insuranceFund.userId();
    // S2: Wallet 행 UPDATE 없음 — 저널이 진실. S0: 기금 balance 행 반영(signed).
    if (!this.useTruth()) {
      const wallet = await tx.wallet.update({
        where: {
          userId_assetSymbol_marketType: {
            userId: fundUserId,
            assetSymbol: USDT,
            marketType: MARKET,
          },
        },
        data: { balance: { increment: amount } },
      });
      this.recordWallet(outcome, wallet);
    }
    outcome.affectedWalletUsers.add(fundUserId);
    // 보험기금 wallet 반영(signed) 저널 — 호출자 sourceKey 재사용(정산 이벤트가 멱등 보장)
    await this.journalLeg(
      tx,
      {
        userId: fundUserId,
        assetSymbol: USDT,
        marketType: MARKET,
        kind: BalanceJournalKind.FUTURES_INSURANCE_FUND,
        deltaBalance: amount,
        deltaLocked: ZERO,
        sourceKey,
        meta: { symbol },
      },
      outcome,
    );
    await tx.futuresIncome.create({
      data: {
        userId: fundUserId,
        tickerSymbol: symbol,
        incomeType: FuturesIncomeType.INSURANCE_CLEAR,
        income: amount,
        sourceKey,
      },
    });
  }

  /** Position 행 잠금. 행이 없으면 기본값으로 생성 후 잠금 (첫 체결 시점). */
  private async lockPosition(
    tx: Prisma.TransactionClient,
    userId: string,
    symbol: string,
  ): Promise<PositionRow> {
    await tx.$executeRaw`
      INSERT INTO "Position" ("userId", "tickerSymbol", "tickerMarket", "updatedAt")
      VALUES (${userId}, ${symbol}, 'FUTURES'::"MarketType", now())
      ON CONFLICT ("userId", "tickerSymbol") DO NOTHING
    `;
    const rows = await tx.$queryRaw<PositionRow[]>`
      SELECT "qty", "entryPrice", "isolatedMargin", "leverage", "status"
      FROM "Position"
      WHERE "userId" = ${userId} AND "tickerSymbol" = ${symbol}
      FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new Error(`position lock failed for ${userId}/${symbol}`);
    }
    return rows[0];
  }

  /** futures USDT wallet 잠금 — flip/shortfall 판정이 balance에 의존하므로 행 잠금 필수. */
  private async lockWallet(tx: Prisma.TransactionClient, userId: string): Promise<WalletRow> {
    const rows = await tx.$queryRaw<WalletRow[]>`
      SELECT "balance", "locked"
      FROM "Wallet"
      WHERE "userId" = ${userId} AND "assetSymbol" = ${USDT} AND "marketType" = 'FUTURES'::"MarketType"
      FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new Error(`futures USDT wallet not found for user ${userId}`);
    }
    return rows[0];
  }

  // ---------- commit 후 후처리 ----------

  private async postApply(outcome: ApplyOutcome): Promise<void> {
    // 커밋된 futures 저널 엔트리를 인메모리 원장에 즉시 멱등 반영 (테일러가 백스톱).
    // S2에선 이게 진실 반영, S0에선 섀도 — 반영 실패는 삼키되 소리내어 기록(정산 파이프라인 무영향).
    for (const row of outcome.journalRows) {
      try {
        this.ledger.applyJournal(toEntry(row));
      } catch (e) {
        this.logger.error(`ledger applyJournal failed for ${row.sourceKey}`, e as Error);
      }
    }

    // S2: Wallet 행을 안 만졌으므로 스냅샷을 원장(진실)에서 합성 (프로젝터가 행을 뒤따라 갱신).
    if (this.useTruth()) {
      for (const userId of outcome.affectedWalletUsers) {
        const { balance, locked } = this.ledger.getDecimal({
          userId,
          assetSymbol: USDT,
          marketType: MARKET,
        });
        outcome.walletByUser.set(userId, {
          asset: USDT,
          free: balance.toFixed(8),
          locked: locked.toFixed(8),
          ts: Date.now(),
        });
      }
    }

    for (const msg of outcome.shortfallLogs) {
      this.logger.error(msg);
    }

    for (const check of outcome.reduceOnlyChecks.values()) {
      try {
        await this.enforceReduceOnly(check.userId, check.symbol);
      } catch (e) {
        this.logger.error(
          `reduceOnly enforcement failed for ${check.userId}/${check.symbol}`,
          e as Error,
        );
      }
    }

    for (const [userId, snapshot] of outcome.walletByUser) {
      this.userEvents.emitAccountPosition(userId, [snapshot]);
    }
    for (const [userId, positions] of outcome.positionByUser) {
      const snapshots = [...positions.values()];
      for (const snapshot of snapshots) await this.enrichPosition(snapshot);
      this.userEvents.emitPositionUpdate(userId, snapshots);
    }
  }

  /** reduceOnly open 주문 정리: 반대 side는 전량 CO(flip 잔존분), 청산 side는 잔여합 > |qty|면 최신부터 CO. */
  private async enforceReduceOnly(userId: string, symbol: string): Promise<void> {
    const position = await this.prisma.position.findUnique({
      where: { userId_tickerSymbol: { userId, tickerSymbol: symbol } },
    });
    const qty = position?.qty ?? ZERO;
    const absQty = qty.abs();

    const openOrders = await this.prisma.order.findMany({
      where: {
        userId,
        tickerSymbol: symbol,
        tickerMarket: MARKET,
        reduceOnly: true,
        status: { in: OPEN_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (openOrders.length === 0) return;

    // flip으로 포지션 방향이 바뀌면 기존 reduceOnly는 증량 방향 — 청산 능력 0이라 전량 CO
    const closingSide = qty.isNegative() ? OrderSide.BUY : OrderSide.SELL;
    const closingOrders: Order[] = [];
    for (const order of openOrders) {
      if (!qty.isZero() && order.side !== closingSide) await this.dispatchCancel(order);
      else closingOrders.push(order);
    }

    let remaining = closingOrders.reduce(
      (sum, o) => sum.add((o.origQty ?? ZERO).sub(o.executedQty)),
      ZERO,
    );
    for (const order of closingOrders) {
      if (remaining.lte(absQty)) break;
      await this.dispatchCancel(order);
      remaining = remaining.sub((order.origQty ?? ZERO).sub(order.executedQty));
    }
  }

  private async dispatchCancel(order: Order): Promise<void> {
    const partition = await this.partitionOf(order.tickerSymbol);
    await this.kafka.emit(inboundTopic(MARKET), partition, serializeCancelOrder(order), order.tickerSymbol);
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

  private recordWallet(outcome: ApplyOutcome, wallet: Wallet): void {
    const prev = outcome.walletByUser.get(wallet.userId);
    const ts = wallet.updatedAt.getTime();
    if (prev && prev.ts > ts) return;
    outcome.walletByUser.set(wallet.userId, {
      asset: wallet.assetSymbol,
      free: wallet.balance.toFixed(8),
      locked: wallet.locked.toFixed(8),
      ts,
    });
  }

  /** mark/UPNL/청산가는 commit 후 emit 시점에 채운다(postApply). 여기선 base 스냅샷만. */
  private recordPosition(outcome: ApplyOutcome, position: PositionRecord): void {
    let bySymbol = outcome.positionByUser.get(position.userId);
    if (!bySymbol) {
      bySymbol = new Map();
      outcome.positionByUser.set(position.userId, bySymbol);
    }
    bySymbol.set(position.tickerSymbol, {
      symbol: position.tickerSymbol,
      qty: position.qty.toFixed(8),
      entryPrice: position.entryPrice.toFixed(8),
      isolatedMargin: position.isolatedMargin.toFixed(8),
      leverage: position.leverage,
      marginMode: position.marginMode,
      status: position.status,
      markPrice: null,
      unrealizedPnl: null,
      liquidationPrice: null,
      ts: position.updatedAt.getTime(),
    });
  }

  /**
   * mark가 있으면 markPrice/UPNL을, ISOLATED는 청산가까지 채운다.
   * CROSS 청산가는 계정 의존이라 null(FE가 REST 보충). qty 0이면 파생값 없음.
   */
  private async enrichPosition(snapshot: FuturesPositionSnapshot): Promise<void> {
    const qty = new Decimal(snapshot.qty);
    if (qty.isZero()) return;
    const mark = this.markPrice.tryGetMark(snapshot.symbol);
    if (mark === null) return;

    const entryPrice = new Decimal(snapshot.entryPrice);
    snapshot.markPrice = mark.toFixed(8);
    snapshot.unrealizedPnl = unrealizedPnl(mark, entryPrice, qty).toFixed(8);
    if (snapshot.marginMode === MarginMode.ISOLATED) {
      const { mmr } = await this.futuresConfig.configOf(snapshot.symbol);
      const isolatedMargin = new Decimal(snapshot.isolatedMargin);
      snapshot.liquidationPrice = liquidationPrice(entryPrice, qty, isolatedMargin, mmr).toFixed(8);
    }
  }
}
