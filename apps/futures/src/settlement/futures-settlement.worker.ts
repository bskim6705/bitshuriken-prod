import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
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
import { FuturesConfigService } from '../config/futures-config.service';
import { MarkPriceService } from '../mark-price/mark-price.service';
import {
  FuturesBalanceSnapshot,
  FuturesPositionSnapshot,
  FuturesUserEventsService,
} from '../user-events/futures-user-events.service';
import { floor8 } from '@app/shared/decimal';
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
}

function emptyOutcome(): ApplyOutcome {
  return {
    walletByUser: new Map(),
    positionByUser: new Map(),
    reduceOnlyChecks: new Map(),
    shortfallLogs: [],
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
export class FuturesSettlementWorker {
  private readonly logger = new Logger(FuturesSettlementWorker.name);
  private readonly partitions = new Map<string, number>();
  private running = false;

  constructor(
    private prisma: PrismaService,
    private kafka: KafkaService,
    private futuresConfig: FuturesConfigService,
    private insuranceFund: InsuranceFundService,
    private userEvents: FuturesUserEventsService,
    private markPrice: MarkPriceService,
  ) {}

  @Interval(100)
  async tick(): Promise<void> {
    if (this.running) return; // 이전 tick이 아직 처리 중이면 skip
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
        this.logger.error(`failed to apply futures event ${event.id} (${event.kind})`, e as Error);
        // 포지션 전이는 순서가 정합성 조건 — 실패 이벤트를 건너뛰지 않고 중단, 다음 tick 재시도
        break;
      }
      await this.postApply(outcome);
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
    const wallet = await this.lockWallet(tx, userId);

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
    const result = applyFill(state, fill, { balance: wallet.balance });

    const updatedPosition = await tx.position.update({
      where: { userId_tickerSymbol: { userId, tickerSymbol: leg.symbol } },
      data: {
        qty: result.newPosition.qty,
        entryPrice: result.newPosition.entryPrice,
        isolatedMargin: result.newPosition.isolatedMargin,
      },
    });
    const updatedWallet = await tx.wallet.update({
      where: {
        userId_assetSymbol_marketType: { userId, assetSymbol: USDT, marketType: MARKET },
      },
      data: {
        balance: { increment: result.walletDeltas.balanceDelta },
        locked: { increment: result.walletDeltas.lockedDelta },
      },
    });

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

    this.recordWallet(outcome, updatedWallet);
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
      const wallet = await this.lockWallet(tx, leg.userId);
      const application = applyFundingPayment(payment, wallet.balance);

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

  /** 기금 wallet 반영(signed — 상쇄 손실은 음수) + INSURANCE_CLEAR 원장. */
  private async creditFund(
    tx: Prisma.TransactionClient,
    symbol: string,
    amount: Decimal,
    sourceKey: string,
    outcome: ApplyOutcome,
  ): Promise<void> {
    const fundUserId = await this.insuranceFund.userId();
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
    await tx.futuresIncome.create({
      data: {
        userId: fundUserId,
        tickerSymbol: symbol,
        incomeType: FuturesIncomeType.INSURANCE_CLEAR,
        income: amount,
        sourceKey,
      },
    });
    this.recordWallet(outcome, wallet);
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
