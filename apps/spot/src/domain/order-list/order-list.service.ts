import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BalanceJournalKind, MarketType, Order, OrderList, OrderStatus } from '@prisma/client';
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
import { OrderDispatchService } from '../order/order-dispatch.service';
import { buildExecutionReport } from '../order/execution-report';
import { validateAgainstMeta } from '../order/order-validation';
import { CreateOrderListDto } from './dto/create-order-list.dto';
import { OcoStateMachine, TERMINAL_STATUSES, decideLegTerminal } from './oco-state-machine';
import { LegFinalValues, resolveFinalization } from './oco-refund';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import {
  MAX_OPEN_ORDERS_PER_SYMBOL,
  MM_MAX_OPEN_ORDERS_PER_SYMBOL,
} from '@app/shared/constants/trading-protection';

const OPEN_STATUSES: OrderStatus[] = ['NEW', 'OPEN', 'PARTIAL'];

const ZERO = new Decimal(0);
const MAX_LIST_QUERY_LIMIT = 500;

type ListWithOrders = OrderList & { orders: Order[] };

interface OcoCreateResult {
  list: OrderList;
  limitLeg: Order;
  stopLeg: Order;
  accountPosition: { asset: string; free: string; locked: string; ts: number };
}

/**
 * OCO 주문 리스트 orchestration. 전이 판정/실행은 oco-state-machine, 환불 산정은 oco-refund.
 * 불변식: orderListId가 있는 주문에 per-order 환불 금지, 환불은 listref:{listId} 단 1회.
 */
@Injectable()
export class OrderListService {
  private readonly logger = new Logger(OrderListService.name);
  // 레그별 최종 eq/cqq (OU 메시지 값) — finalize 환불 산정용. 재시작 시엔 drain 후 DB 값 사용.
  private readonly finalLegValues = new Map<string, LegFinalValues>();
  // 부트 복구(drain 후) 완료 전엔 DB eq/cqq가 stale일 수 있음 — hint 없는 결정 차단용
  private recovered = false;

  constructor(
    private prisma: PrismaService,
    private tickerStats: TickerStatsService,
    private userStream: UserStreamService,
    private settlement: SettlementService,
    private registry: TriggerRegistryService,
    private dispatch: OrderDispatchService,
    private machine: OcoStateMachine,
    private users: UserService,
    private journal: JournalWriter,
    private ledger: LedgerService,
    private availability: LedgerAvailability,
  ) {}

  /** S2 진실 경로 판정: 스위치 ON + 저널 가용(테이블 부재면 S0 행 경로로 안전 강등). */
  private useTruth(): boolean {
    return LEDGER_TRUTH && this.availability.enabled;
  }

  // ---------- placement ----------

  async createOcoList(userId: string, dto: CreateOrderListDto) {
    const meta = this.tickerStats.metaOf(dto.tickerMarket, dto.tickerSymbol);
    if (!meta)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        'Ticker not found',
        HttpStatus.NOT_FOUND,
      );

    // 상장 상태 게이트 — 비-TRADING ticker는 신규 OCO 거부
    await this.tickerStats.assertTradable(dto.tickerMarket, dto.tickerSymbol);
    // 계정 거래 정지 게이트
    await this.users.assertCanTrade(userId);

    // 오픈주문 상한 — OCO는 2건(limit + stop)을 차지.
    const openCount = await this.prisma.order.count({
      where: {
        userId,
        tickerSymbol: dto.tickerSymbol,
        tickerMarket: dto.tickerMarket,
        status: { in: OPEN_STATUSES },
      },
    });
    if (openCount + 2 > MAX_OPEN_ORDERS_PER_SYMBOL) {
      // 일반 상한 도달 시에만 유저 조회 — 시장조성 계정(rateLimitExempt)은 상향 캡 (ADR-068)
      const mm = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { rateLimitExempt: true },
      });
      const cap = mm?.rateLimitExempt ? MM_MAX_OPEN_ORDERS_PER_SYMBOL : MAX_OPEN_ORDERS_PER_SYMBOL;
      if (openCount + 2 > cap) {
        throw new DomainException(
          ErrorCode.MAX_NUM_ORDERS_EXCEEDED,
          `Open-order limit reached for ${dto.tickerSymbol} (max ${cap})`,
        );
      }
    }

    const qty = new Decimal(dto.qty);
    const price = new Decimal(dto.price);
    const stopPrice = new Decimal(dto.stopPrice);
    const stopLimitPrice = new Decimal(dto.stopLimitPrice);

    const last = await this.lastPriceOf(dto.tickerMarket, dto.tickerSymbol);
    if (last === null) {
      throw new DomainException(
        ErrorCode.OCO_PRICE_INVALID,
        'No last price available — OCO price relations cannot be validated',
      );
    }
    if (dto.side === 'SELL') {
      if (!(price.gt(last) && last.gt(stopPrice))) {
        throw new DomainException(
          ErrorCode.OCO_PRICE_INVALID,
          'OCO SELL requires price > last price > stopPrice',
        );
      }
    } else {
      if (!(price.lt(last) && last.lt(stopPrice))) {
        throw new DomainException(
          ErrorCode.OCO_PRICE_INVALID,
          'OCO BUY requires price < last price < stopPrice',
        );
      }
    }

    // 가격 밴드 기준가 = 5m 가중평균(있으면), 없으면 last(위에서 non-null 보장).
    const avg = this.tickerStats.avgPrice5m(dto.tickerMarket, dto.tickerSymbol);
    const bandRefPrice = avg !== null ? new Decimal(avg) : last;

    // 양 레그 모두 tick/step/minNotional + 가격 밴드 검증
    validateAgainstMeta({
      type: 'LIMIT',
      side: dto.side,
      price,
      stopPrice: null,
      origQty: qty,
      origQuoteQty: null,
      meta,
      lastPrice: last,
      bandRefPrice,
    });
    validateAgainstMeta({
      type: 'STOP_LOSS_LIMIT',
      side: dto.side,
      price: stopLimitPrice,
      stopPrice,
      origQty: qty,
      origQuoteQty: null,
      meta,
      lastPrice: last,
      bandRefPrice,
    });

    // 리스트 단위 잠금 1회: SELL은 base qty, BUY는 quote max(price, stopLimitPrice)*qty
    const lockAssetSymbol = dto.side === 'SELL' ? meta.baseAsset : meta.quoteAsset;
    const lockAmount = dto.side === 'SELL' ? qty : Decimal.max(price, stopLimitPrice).mul(qty);

    const created = this.useTruth()
      ? await this.createOcoWithLedger(userId, dto, lockAssetSymbol, lockAmount, qty, price, stopPrice, stopLimitPrice)
      : await this.createOcoWithWallet(userId, dto, lockAssetSymbol, lockAmount, qty, price, stopPrice, stopLimitPrice);

    this.userStream.emitAccountPosition(userId, [created.accountPosition]);
    this.reportLocal(created.limitLeg, 'NEW');
    this.reportLocal(created.stopLeg, 'NEW');
    this.userStream.emitListStatus(userId, {
      orderListId: created.list.id,
      symbol: created.list.tickerSymbol,
      status: 'EXECUTING',
      orders: [
        { orderId: created.limitLeg.id, status: created.limitLeg.status },
        { orderId: created.stopLeg.id, status: created.stopLeg.status },
      ],
      ts: Date.now(),
    });

    await this.dispatch.dispatchNewOrder(created.limitLeg);

    // stop 레그 트리거 활성화는 limit NO 전송 후 — 그 전에 트리거되면 엔진이 모르는 주문에 CO가 나간다
    this.registry.add(created.stopLeg);

    return { orderList: created.list, orders: [created.limitLeg, created.stopLeg] };
  }

  /**
   * S2 진실 경로: 리스트 단위 동결을 ledger.reserve()로 선행 → 성공 시 tx = OrderList/leg INSERT +
   * 저널 INSERT만(Wallet 행 UPDATE 없음) → tx 실패 시 rollbackReserve. accountPosition은 원장 스냅샷.
   */
  private async createOcoWithLedger(
    userId: string,
    dto: CreateOrderListDto,
    lockAssetSymbol: string,
    lockAmount: Decimal,
    qty: Decimal,
    price: Decimal,
    stopPrice: Decimal,
    stopLimitPrice: Decimal,
  ): Promise<OcoCreateResult> {
    const parts = { userId, assetSymbol: lockAssetSymbol, marketType: dto.tickerMarket };
    const listId = randomUUID();
    const sourceKey = SourceKey.spotOcoLock(listId);
    if (!this.ledger.reserve(parts, lockAmount, sourceKey)) {
      throw new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');
    }
    try {
      const { list, limitLeg, stopLeg } = await this.prisma.$transaction(async (tx) => {
        const list = await tx.orderList.create({
          data: {
            id: listId,
            userId,
            tickerSymbol: dto.tickerSymbol,
            tickerMarket: dto.tickerMarket,
            side: dto.side,
            contingencyType: 'OCO',
            lockAssetSymbol,
            lockAmount,
          },
        });
        const limitLeg = await tx.order.create({
          data: {
            userId,
            tickerSymbol: dto.tickerSymbol,
            tickerMarket: dto.tickerMarket,
            type: 'LIMIT',
            side: dto.side,
            timeInForce: 'GTC',
            price,
            origQty: qty,
            orderListId: list.id,
            status: 'NEW',
          },
        });
        const stopLeg = await tx.order.create({
          data: {
            userId,
            tickerSymbol: dto.tickerSymbol,
            tickerMarket: dto.tickerMarket,
            type: 'STOP_LOSS_LIMIT',
            side: dto.side,
            timeInForce: dto.stopLimitTimeInForce,
            price: stopLimitPrice,
            stopPrice,
            origQty: qty,
            orderListId: list.id,
            status: 'NEW',
          },
        });
        await this.journal.writeInTx(tx, {
          userId,
          assetSymbol: lockAssetSymbol,
          marketType: dto.tickerMarket,
          kind: BalanceJournalKind.SPOT_PLACE_LOCK,
          deltaBalance: lockAmount.neg(),
          deltaLocked: lockAmount,
          sourceKey,
          meta: { listId: list.id, limitLegId: limitLeg.id, stopLegId: stopLeg.id },
        });
        return { list, limitLeg, stopLeg };
      });
      const snap = this.ledger.getDecimal(parts);
      return {
        list,
        limitLeg,
        stopLeg,
        accountPosition: {
          asset: lockAssetSymbol,
          free: snap.balance.toFixed(8),
          locked: snap.locked.toFixed(8),
          ts: list.createdAt.getTime(),
        },
      };
    } catch (e) {
      this.ledger.rollbackReserve(parts, lockAmount, sourceKey);
      throw e;
    }
  }

  /** S0 경로: findUnique → 원자적 조건부 차감(updateMany) → OrderList/leg INSERT + 병행 저널. */
  private async createOcoWithWallet(
    userId: string,
    dto: CreateOrderListDto,
    lockAssetSymbol: string,
    lockAmount: Decimal,
    qty: Decimal,
    price: Decimal,
    stopPrice: Decimal,
    stopLimitPrice: Decimal,
  ): Promise<OcoCreateResult> {
    const created = await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: {
          userId_assetSymbol_marketType: {
            userId,
            assetSymbol: lockAssetSymbol,
            marketType: dto.tickerMarket,
          },
        },
      });
      if (!wallet)
        throw new DomainException(
          ErrorCode.WALLET_NOT_FOUND,
          `Wallet not found for ${lockAssetSymbol}`,
        );

      // 원자적 조건부 차감 — check-then-update는 동시 주문에서 초과 인출 가능
      const debit = await tx.wallet.updateMany({
        where: {
          userId,
          assetSymbol: lockAssetSymbol,
          marketType: dto.tickerMarket,
          balance: { gte: lockAmount },
        },
        data: {
          balance: { decrement: lockAmount },
          locked: { increment: lockAmount },
        },
      });
      if (debit.count === 0)
        throw new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');

      const updatedWallet = await tx.wallet.findUnique({
        where: {
          userId_assetSymbol_marketType: {
            userId,
            assetSymbol: lockAssetSymbol,
            marketType: dto.tickerMarket,
          },
        },
      });
      if (!updatedWallet) {
        throw new Error(`wallet row vanished after debit (${userId}/${lockAssetSymbol})`);
      }

      const list = await tx.orderList.create({
        data: {
          userId,
          tickerSymbol: dto.tickerSymbol,
          tickerMarket: dto.tickerMarket,
          side: dto.side,
          contingencyType: 'OCO',
          lockAssetSymbol,
          lockAmount,
        },
      });

      const limitLeg = await tx.order.create({
        data: {
          userId,
          tickerSymbol: dto.tickerSymbol,
          tickerMarket: dto.tickerMarket,
          type: 'LIMIT',
          side: dto.side,
          timeInForce: 'GTC',
          price,
          origQty: qty,
          orderListId: list.id,
          status: 'NEW',
        },
      });

      const stopLeg = await tx.order.create({
        data: {
          userId,
          tickerSymbol: dto.tickerSymbol,
          tickerMarket: dto.tickerMarket,
          type: 'STOP_LOSS_LIMIT',
          side: dto.side,
          timeInForce: dto.stopLimitTimeInForce,
          price: stopLimitPrice,
          stopPrice,
          origQty: qty,
          orderListId: list.id,
          status: 'NEW',
        },
      });

      // S0 원장 섀도: 리스트 단위 동결을 wallet 변이와 동일 델타로 저널에 병행 기록 (동일 tx).
      const journalRow = await this.journal.writeInTx(tx, {
        userId,
        assetSymbol: lockAssetSymbol,
        marketType: dto.tickerMarket,
        kind: BalanceJournalKind.SPOT_PLACE_LOCK,
        deltaBalance: lockAmount.neg(),
        deltaLocked: lockAmount,
        sourceKey: SourceKey.spotOcoLock(list.id),
        meta: { listId: list.id, limitLegId: limitLeg.id, stopLegId: stopLeg.id },
      });

      return { list, limitLeg, stopLeg, wallet: updatedWallet, journalRow };
    });

    // 커밋 후 자기 마켓 엔트리 즉시 로컬 반영 (멱등 — tailer 재수신은 sourceKey로 no-op).
    if (created.journalRow && this.ledger.owns(dto.tickerMarket)) {
      this.ledger.applyJournal(toEntry(created.journalRow));
    }

    return {
      list: created.list,
      limitLeg: created.limitLeg,
      stopLeg: created.stopLeg,
      accountPosition: {
        asset: created.wallet.assetSymbol,
        free: created.wallet.balance.toFixed(8),
        locked: created.wallet.locked.toFixed(8),
        ts: created.wallet.updatedAt.getTime(),
      },
    };
  }

  // ---------- state machine ----------

  /** 레그 체결 감지 (handleTrade에서 await): stop 레그가 아직 NEW+미트리거면 로컬 취소. 멱등. */
  async onLegExecuted(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderListId: true },
    });
    if (!order?.orderListId) return;

    const list = await this.loadList(order.orderListId);
    if (!list) return;
    const { stopLeg } = this.splitLegs(list);
    if (!stopLeg) return;

    if (stopLeg.status === 'NEW' && stopLeg.triggeredAt === null) {
      // limit이 이미 terminal일 수 있는 재처리 경로 대비 — 멱등 finalize 시도 포함
      await this.cancelStopThenResolve(list, stopLeg);
    }
  }

  /**
   * Flow B step 1: stop 트리거됨 → limit 레그 취소 요청. (registry에서 stop은 이미 동기 제거됨)
   * redrive = 직전 발화가 전송 실패로 끝남 — claim만 잡히고 유실된 CO/NO를 재드라이브한다.
   */
  async onStopTriggered(stopLeg: Order, redrive = false): Promise<void> {
    if (!stopLeg.orderListId) {
      throw new Error(`onStopTriggered called for non-OCO order ${stopLeg.id}`);
    }
    const list = await this.loadList(stopLeg.orderListId);
    if (!list) return;
    const { limitLeg, stopLeg: stopRow } = this.splitLegs(list);
    if (!limitLeg || !stopRow) return;

    // limit이 이미 terminal이면 즉시 step 2 — 엔진은 unknown CO에 무응답이므로 OU를 기다리지 않는다.
    if (TERMINAL_STATUSES.has(limitLeg.status)) {
      // 재발화 + 이미 armed = arming NO가 유실됐을 수 있음 — 재드라이브(엔진 멱등) 후 취소 재확인
      if (redrive && stopRow.status === 'NEW' && stopRow.triggeredAt !== null) {
        await this.dispatch.dispatchNewOrder(stopRow);
        this.reportLocal(stopRow, 'NEW');
        await this.redriveCancelIfRequested(list.id, stopRow);
        return;
      }
      await this.onLegTerminal(list.id);
      return;
    }

    const claimed = await this.machine.claimStopPending(list.id);
    if (!claimed) {
      // 재발화 경로: claim만 커밋되고 limit CO가 유실됐을 수 있음 — 재전송 (중복 CO는 엔진이 무시)
      if (redrive && list.stopPendingAt !== null && !list.cancelRequested) {
        await this.dispatch.dispatchCancelOrder(limitLeg);
      }
      return;
    }

    await this.dispatch.dispatchCancelOrder(limitLeg);
  }

  /**
   * OCO 레그의 terminal 전이(OU/로컬) 후 호출. hint = OU 메시지의 eq/cqq.
   * trigger-pending 메모리 상태와 무관하게 항상 동작 — DB 주도.
   */
  async onLegTerminal(
    listId: string,
    hint?: { orderId: string; eq: Decimal; cqq: Decimal },
  ): Promise<void> {
    if (hint) this.finalLegValues.set(hint.orderId, { eq: hint.eq, cqq: hint.cqq });

    const list = await this.loadList(listId);
    if (!list) return;
    const { limitLeg, stopLeg } = this.splitLegs(list);
    if (!limitLeg || !stopLeg) return;

    // 복구 전 + hint 없는 terminal 레그 = DB eq/cqq가 stale일 수 있음(worker 비동기 적용).
    // 잘못된 arming/환불 산정을 막기 위해 미루고 부트 복구 재실행에 맡긴다.
    if (!this.recovered) {
      const missingHint = [limitLeg, stopLeg].some(
        (leg) => TERMINAL_STATUSES.has(leg.status) && !this.finalLegValues.has(leg.id),
      );
      if (missingHint) {
        this.logger.warn(`deferring OCO resolution for list ${listId} until boot recovery`);
        return;
      }
    }

    const action = decideLegTerminal({
      cancelRequested: list.cancelRequested,
      limitStatus: limitLeg.status,
      stopStatus: stopLeg.status,
      stopArmed: stopLeg.triggeredAt !== null,
      limitExecutedZero: this.finalValuesOf(limitLeg).eq.isZero(),
    });

    switch (action) {
      case 'ARM_STOP': {
        // Flow B step 2 arming: stop 레그를 엔진으로
        if (await this.machine.claimArmStop(stopLeg.id)) {
          this.registry.remove(stopLeg.id);
          await this.machine.clearStopPending(list.id);
          await this.dispatch.dispatchNewOrder(stopLeg);
          this.reportLocal(stopLeg, 'NEW'); // arming 후 executionReport
          // NO ack 후 취소 재확인 — 그 사이 나간 cancelList의 CO는 NO를 앞질러 무시됐을 수 있다
          await this.redriveCancelIfRequested(list.id, stopLeg);
          return;
        }
        // claim 0: 취소와의 레이스 패배 → 로컬 취소 경로로
        await this.cancelStopThenResolve(list, stopLeg);
        return;
      }
      case 'CANCEL_STOP_LOCALLY':
        await this.cancelStopThenResolve(list, stopLeg);
        return;
      case 'FINALIZE':
        await this.finalize(list, limitLeg, stopLeg);
        return;
      case 'NONE':
        return;
    }
  }

  /** 유저 리스트 취소. guarded cancelRequested claim → 레그별 취소 라우팅. */
  async cancelList(
    userId: string,
    listId: string,
    opts?: { idempotent?: boolean },
  ): Promise<{ orderList: OrderList; orders: Order[] }> {
    const list = await this.loadList(listId);
    if (!list)
      throw new DomainException(
        ErrorCode.ORDER_LIST_NOT_FOUND,
        'Order list not found',
        HttpStatus.NOT_FOUND,
      );
    if (list.userId !== userId)
      throw new DomainException(ErrorCode.FORBIDDEN, 'Not your order list', HttpStatus.FORBIDDEN);

    const claimed = await this.machine.claimCancelRequested(listId);
    if (!claimed && !opts?.idempotent) {
      throw new DomainException(
        ErrorCode.ORDER_LIST_NOT_CANCELABLE,
        'Order list is not cancelable',
      );
    }

    if (claimed) {
      const { limitLeg, stopLeg } = this.splitLegs(list);
      if (stopLeg && !TERMINAL_STATUSES.has(stopLeg.status)) {
        if (stopLeg.status === 'NEW' && stopLeg.triggeredAt === null) {
          const canceled = await this.cancelStopLegLocally(list, stopLeg);
          // 레이스 패배(armed 직전/직후) — 엔진 거주 가능성에 대비해 CO
          if (!canceled) await this.dispatch.dispatchCancelOrder(stopLeg);
        } else {
          await this.dispatch.dispatchCancelOrder(stopLeg);
        }
      }
      if (limitLeg && !TERMINAL_STATUSES.has(limitLeg.status)) {
        await this.dispatch.dispatchCancelOrder(limitLeg);
      }
      // 양 레그가 이미 terminal이면 즉시 finalize (그 외엔 OU 흐름이 자연 finalize)
      await this.onLegTerminal(listId);
    }

    const refreshed = await this.loadList(listId);
    if (!refreshed)
      throw new DomainException(
        ErrorCode.ORDER_LIST_NOT_FOUND,
        'Order list not found',
        HttpStatus.NOT_FOUND,
      );
    return { orderList: refreshed, orders: refreshed.orders };
  }

  // ---------- boot recovery ----------

  /** 부트 복구 — settlement drain 완료 후 호출 (DB 값이 authoritative). */
  async runBootRecovery(): Promise<void> {
    // drain 완료 후 시작 — 이후 DB eq/cqq fallback 허용 (미뤄둔 케이스도 여기서 재실행)
    this.recovered = true;
    const lists = await this.prisma.orderList.findMany({
      where: { status: 'EXECUTING' },
      include: { orders: true },
    });
    for (const list of lists) {
      try {
        await this.recoverList(list);
      } catch (e) {
        this.logger.error(`OCO boot recovery failed for list ${list.id}`, e as Error);
      }
    }
    if (lists.length > 0) {
      this.logger.log(`OCO boot recovery scanned ${lists.length} EXECUTING lists`);
    }
  }

  private async recoverList(list: ListWithOrders): Promise<void> {
    const { limitLeg, stopLeg } = this.splitLegs(list);
    if (!limitLeg || !stopLeg) {
      this.logger.error(`order list ${list.id} is malformed (missing leg)`);
      return;
    }
    const limitTerminal = TERMINAL_STATUSES.has(limitLeg.status);
    const stopTerminal = TERMINAL_STATUSES.has(stopLeg.status);

    if (limitTerminal && stopTerminal) {
      this.logger.warn(`OCO recovery: finalizing list ${list.id} (both legs terminal)`);
      await this.onLegTerminal(list.id);
      return;
    }
    // 유저 취소 접수 후 CO가 유실됐을 수 있음(크래시 / NO 앞지름) — 취소를 재드라이브
    if (list.cancelRequested) {
      this.logger.warn(`OCO recovery: re-driving cancel for list ${list.id}`);
      if (!stopTerminal) {
        if (stopLeg.status === 'NEW' && stopLeg.triggeredAt === null) {
          const canceled = await this.cancelStopLegLocally(list, stopLeg);
          if (!canceled) await this.dispatch.dispatchCancelOrder(stopLeg);
        } else {
          // armed NEW는 NO 미전송 가능성 — NO 재드라이브(엔진 멱등) 후 CO로 취소 확정
          if (stopLeg.status === 'NEW') await this.dispatch.dispatchNewOrder(stopLeg);
          await this.dispatch.dispatchCancelOrder(stopLeg);
        }
      }
      if (!limitTerminal) await this.dispatch.dispatchCancelOrder(limitLeg);
      await this.onLegTerminal(list.id);
      return;
    }
    if (list.stopPendingAt !== null && !limitTerminal) {
      this.logger.warn(
        `OCO recovery: re-emitting CO for limit leg ${limitLeg.id} of list ${list.id}`,
      );
      await this.dispatch.dispatchCancelOrder(limitLeg);
      return;
    }
    if (stopLeg.status === 'NEW' && stopLeg.triggeredAt !== null) {
      this.logger.warn(
        `OCO recovery: re-emitting NO for armed-but-unsent stop leg ${stopLeg.id} of list ${list.id}`,
      );
      await this.dispatch.dispatchNewOrder(stopLeg);
      return;
    }
    if (limitTerminal && stopLeg.status === 'NEW' && stopLeg.triggeredAt === null) {
      this.logger.warn(`OCO recovery: re-running onLegTerminal for list ${list.id}`);
      await this.onLegTerminal(list.id);
      return;
    }
    // 크래시 윈도우: createOcoList tx 커밋 후 limit NO 발행 전 크래시 → limit이 엔진에 미전송.
    // DB상 정상 상태(양 레그 NEW)와 구분 불가하므로 재드라이브 — 엔진 멱등(이미 resting이면 무시).
    // stop 재arm은 trigger.service onApplicationBootstrap이 담당하므로 여기선 limit만.
    if (
      limitLeg.status === 'NEW' &&
      stopLeg.status === 'NEW' &&
      stopLeg.triggeredAt === null &&
      list.stopPendingAt === null
    ) {
      this.logger.warn(
        `OCO recovery: re-dispatching limit leg ${limitLeg.id} of list ${list.id} (crash window)`,
      );
      await this.dispatch.dispatchNewOrder(limitLeg);
    }
  }

  // ---------- read ----------

  findByUser(userId: string, market: MarketType, limit: number) {
    const safeLimit = Math.min(Math.max(1, limit), MAX_LIST_QUERY_LIMIT);
    return this.prisma.orderList.findMany({
      where: { userId, tickerMarket: market },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
      include: { orders: true },
    });
  }

  async findOneForUser(userId: string, listId: string) {
    const list = await this.prisma.orderList.findUnique({
      where: { id: listId },
      include: { orders: true },
    });
    if (!list)
      throw new DomainException(
        ErrorCode.ORDER_LIST_NOT_FOUND,
        'Order list not found',
        HttpStatus.NOT_FOUND,
      );
    if (list.userId !== userId)
      throw new DomainException(ErrorCode.FORBIDDEN, 'Not your order list', HttpStatus.FORBIDDEN);
    return list;
  }

  // ---------- helpers ----------

  /** stop 로컬 취소 후 양 레그 terminal이면 재진입 finalize. */
  private async cancelStopThenResolve(list: ListWithOrders, stopLeg: Order): Promise<void> {
    const canceled = await this.cancelStopLegLocally(list, stopLeg);
    if (canceled) {
      await this.onLegTerminal(list.id); // 양 레그 terminal → finalize
    }
  }

  /** finalize: guarded EXECUTING 전이 + listref 환불 1회 + listStatus emit. */
  private async finalize(list: ListWithOrders, limitLeg: Order, stopLeg: Order): Promise<void> {
    // 환불 산정은 순수 함수 — sourceKey unique가 이중 INSERT 차단.
    const { finalStatus, refundAmount } = resolveFinalization({
      side: list.side,
      lockAmount: list.lockAmount,
      limitStatus: limitLeg.status,
      stopStatus: stopLeg.status,
      limitVals: this.finalValuesOf(limitLeg),
      stopVals: this.finalValuesOf(stopLeg),
    });

    // 종결 claim + 환불 INSERT를 한 트랜잭션으로 — 둘 사이 크래시 시 리스트 잠금 누수 방지
    const claimed = await this.prisma.$transaction(async (tx) => {
      if (!(await this.machine.claimFinalized(list.id, finalStatus, tx))) return false;
      await this.settlement.recordListRefund(
        {
          listId: list.id,
          userId: list.userId,
          market: list.tickerMarket,
          assetSymbol: list.lockAssetSymbol,
          amount: refundAmount,
        },
        tx,
      );
      return true;
    });
    if (!claimed) return; // 이미 finalize됨

    this.finalLegValues.delete(limitLeg.id);
    this.finalLegValues.delete(stopLeg.id);

    this.userStream.emitListStatus(list.userId, {
      orderListId: list.id,
      symbol: list.tickerSymbol,
      status: finalStatus,
      orders: [
        { orderId: limitLeg.id, status: limitLeg.status },
        { orderId: stopLeg.id, status: stopLeg.status },
      ],
      ts: Date.now(),
    });
  }

  /**
   * arming NO ack 후 취소 요청 재확인. 전송 호출 간 순서 미보장이라 cancelList의 CO가
   * NO를 앞질러 엔진에서 무시될 수 있다 — 취소 요청이 있으면 NO 뒤에 CO를 다시 보낸다.
   * 원래 CO가 늦게 도착해 중복돼도 엔진이 unknown CO를 무시하므로 무해.
   */
  private async redriveCancelIfRequested(listId: string, stopLeg: Order): Promise<void> {
    const fresh = await this.prisma.orderList.findUnique({
      where: { id: listId },
      select: { cancelRequested: true },
    });
    if (!fresh?.cancelRequested) return;
    try {
      await this.dispatch.dispatchCancelOrder(stopLeg);
    } catch (e) {
      // 부트 복구의 cancelRequested 재드라이브가 백스톱
      this.logger.error(`post-arm cancel redrive failed for list ${listId}`, e as Error);
    }
  }

  /** stop 레그 guarded 로컬 취소 (NEW+미트리거 한정). 성공 시 true. */
  private async cancelStopLegLocally(list: ListWithOrders, stopLeg: Order): Promise<boolean> {
    if (!(await this.machine.claimLocalStopCancel(stopLeg.id))) return false;

    this.registry.remove(stopLeg.id);
    this.finalLegValues.set(stopLeg.id, { eq: ZERO, cqq: ZERO });
    await this.machine.clearStopPending(list.id);
    this.reportLocal(stopLeg, 'CANCELED');
    return true;
  }

  private finalValuesOf(order: Order): LegFinalValues {
    // OU 추적값 우선. 없으면(재시작 복구) drain 완료된 DB 값.
    return (
      this.finalLegValues.get(order.id) ?? {
        eq: order.executedQty,
        cqq: order.cumulativeQuoteQty,
      }
    );
  }

  private async loadList(listId: string): Promise<ListWithOrders | null> {
    const list = await this.prisma.orderList.findUnique({
      where: { id: listId },
      include: { orders: true },
    });
    if (!list) this.logger.error(`unknown order list ${listId}`);
    return list;
  }

  private splitLegs(list: ListWithOrders): { limitLeg: Order | null; stopLeg: Order | null } {
    const stopLeg = list.orders.find((o) => o.stopPrice !== null) ?? null;
    const limitLeg = list.orders.find((o) => o.stopPrice === null) ?? null;
    if (!stopLeg || !limitLeg) {
      this.logger.error(`order list ${list.id} is malformed (orders=${list.orders.length})`);
    }
    return { limitLeg, stopLeg };
  }

  private reportLocal(order: Order, status: OrderStatus): void {
    const meta = this.tickerStats.metaOf(order.tickerMarket, order.tickerSymbol);
    if (!meta) {
      this.logger.error(`no ticker meta for ${order.tickerMarket}/${order.tickerSymbol}`);
      return;
    }
    this.userStream.emitExecutionReport(
      order.userId,
      buildExecutionReport(order, meta, {
        executedQty: ZERO,
        cumulativeQuoteQty: ZERO,
        status,
        ts: Date.now(),
      }),
    );
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
