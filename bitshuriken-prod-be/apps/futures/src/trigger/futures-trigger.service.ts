import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { MarketType, Order, OrderStatus, OrderType, PositionStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { UserService } from '@app/core-domain/user/user.service';
import { isMarketLike } from '@app/shared/order-classify';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { MarkPriceService, MarkPriceEvent } from '../mark-price/mark-price.service';
import { MarginService } from '../margin/margin.service';
import { FuturesConfigService } from '../config/futures-config.service';
import { PositionService } from '../position/position.service';
import { FuturesUserEventsService } from '../user-events/futures-user-events.service';
import { stopTriggered } from '../http/trading/futures-order-validation';
import { FuturesTriggerRegistryService } from './futures-trigger-registry.service';
import { FuturesOrderDispatchService } from './futures-order-dispatch.service';

const MARKET = MarketType.FUTURES;
const ZERO = new Decimal(0);
// Position 행 없음 = leverage 미설정 — placeOrder의 기본값과 일치해야 cost가 맞다
const DEFAULT_LEVERAGE = 10;
const DRAIN_POLL_MS = 500;
const DRAIN_TIMEOUT_MS = 60_000;
const RECOVERY_DELAY_MS = 10_000;

/**
 * BE 보관 선물 stop 주문의 트리거 평가 — 기준은 mark price (spot은 last trade price).
 * 발화 시점에 증거금을 잠근다(접수 시 무잠금). 진실은 DB guarded claim, registry는 후보 탐색용.
 * onMark 리스너의 registry 확인/제거는 어떤 await보다 먼저 동기 실행 (이중 트리거 방지).
 */
@Injectable()
export class FuturesTriggerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FuturesTriggerService.name);
  private unsubscribe: (() => void) | null = null;

  constructor(
    private prisma: PrismaService,
    private markPrice: MarkPriceService,
    private registry: FuturesTriggerRegistryService,
    private dispatch: FuturesOrderDispatchService,
    private margin: MarginService,
    private futuresConfig: FuturesConfigService,
    private positions: PositionService,
    private users: UserService,
    private tickerStats: TickerStatsService,
    private userEvents: FuturesUserEventsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const pending = await this.prisma.order.findMany({
      where: { tickerMarket: MARKET, stopPrice: { not: null }, triggeredAt: null, status: 'NEW' },
    });
    for (const order of pending) this.registry.add(order);
    this.logger.log(`rehydrated ${pending.length} untriggered futures stop orders`);

    this.unsubscribe = this.markPrice.onMark((event) => this.onMark(event));

    void this.runBootRecovery().catch((e) => {
      this.logger.error('futures stop boot recovery failed', e as Error);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  // ---------- trigger evaluation ----------

  private onMark(event: MarkPriceEvent): void {
    const candidates = this.registry.pendingFor(MARKET, event.symbol);
    if (candidates.length === 0) return;

    // claim-before-await: 한 tick의 다중 후보 이중 트리거 방지 — 제거까지 동기
    const triggered: Order[] = [];
    for (const order of candidates) {
      if (stopTriggered(order.type, order.side, order.stopPrice!, event.mark)) {
        this.registry.remove(order.id);
        triggered.push(order);
      }
    }

    for (const order of triggered) {
      void this.fire(order).catch((e) => {
        this.logger.error(`failed to fire triggered futures stop ${order.id}`, e as Error);
        this.registry.add(order); // 복원 — 다음 tick에서 재평가
      });
    }
  }

  /** 발화: LIQUIDATING 가드 → cost 재산정(non-reduceOnly) → 원자 잠금+claim → NO 전송. */
  private async fire(order: Order): Promise<void> {
    const position = await this.positions.findByUserAndSymbol(order.userId, order.tickerSymbol);
    // 청산 중 포지션에는 발화 금지 — 청산 시퀀스에 신규 주문 주입 차단
    if (position?.status === PositionStatus.LIQUIDATING) {
      await this.reject(order);
      return;
    }

    const meta = this.tickerStats.metaOf(MARKET, order.tickerSymbol);
    if (!meta) {
      this.logger.error(`no ticker meta for ${order.tickerSymbol} — cannot fire ${order.id}`);
      this.registry.add(order);
      return;
    }

    let cost = ZERO;
    if (!order.reduceOnly) {
      const mark = this.markPrice.getMark(order.tickerSymbol); // throw → 상위 catch → 재시도
      const config = await this.futuresConfig.configOf(order.tickerSymbol);
      let admissionPrice: Decimal;
      try {
        admissionPrice = this.margin.admissionPriceOf({
          type: isMarketLike(order.type) ? OrderType.MARKET : OrderType.LIMIT,
          side: order.side,
          price: order.price,
          mark,
          priceBandPct: config.priceBandPct,
          marketCostBufferPct: config.marketCostBufferPct,
        });
      } catch (e) {
        // 발화 시점 limit 가격이 밴드 밖 — 더 이상 유효치 않음 → 거부 (재시도 무의미)
        if (e instanceof DomainException && e.code === ErrorCode.PRICE_OUT_OF_BAND) {
          await this.reject(order);
          return;
        }
        throw e;
      }
      const { takerBps } = await this.users.feeRatesOf(order.userId, MarketType.FUTURES);
      cost = this.margin.costOf({
        side: order.side,
        admissionPrice,
        mark,
        qty: order.origQty!,
        leverage: position?.leverage ?? DEFAULT_LEVERAGE,
        takerFeeBps: takerBps,
      });
    }

    const result = await this.margin.armTriggeredStop({
      orderId: order.id,
      userId: order.userId,
      lockAssetSymbol: meta.quoteAsset,
      cost,
    });
    if (result === 'lost') return; // 취소가 선점
    if (result === 'insufficient') {
      await this.reject(order);
      return;
    }

    const armed: Order = { ...order, triggeredAt: new Date(), lockedCost: cost };
    await this.dispatch.dispatchNewOrder(armed);
    this.emitReport(armed, 'NEW');
  }

  /** 발화 불가(증거금 부족/밴드 이탈/청산 중) stop을 REJECTED 전이. 잠금 없음 → 환불 불필요. */
  private async reject(order: Order): Promise<void> {
    const claim = await this.prisma.order.updateMany({
      where: { id: order.id, status: 'NEW', triggeredAt: null },
      data: { status: 'REJECTED' },
    });
    if (claim.count === 0) return; // 취소가 선점
    this.logger.warn(`futures stop ${order.id} rejected at trigger (margin/band/liquidating)`);
    this.emitReport({ ...order, status: 'REJECTED' }, 'REJECTED');
  }

  private emitReport(order: Order, status: OrderStatus): void {
    this.userEvents.emitExecutionReport(order.userId, {
      orderId: order.id,
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

  // ---------- boot recovery ----------

  /** armed-but-unsent 복구: settlement drain 대기 → +10s → NEW+triggeredAt!=null 재전송. */
  private async runBootRecovery(): Promise<void> {
    await this.waitForSettlementDrain();
    await sleep(RECOVERY_DELAY_MS);

    const armed = await this.prisma.order.findMany({
      where: {
        tickerMarket: MARKET,
        status: 'NEW',
        triggeredAt: { not: null },
        stopPrice: { not: null },
      },
    });
    for (const order of armed) {
      // Kafka 백로그의 OU가 그 사이 처리됐다면 status가 바뀌어 위 스캔에서 자연 스킵된다.
      this.logger.warn(`boot recovery: re-emitting NO for armed-but-unsent futures stop ${order.id}`);
      await this.dispatch.dispatchNewOrder(order);
    }
    if (armed.length === 0) {
      this.logger.log('boot recovery: no armed-but-unsent futures stop orders');
    }
  }

  private async waitForSettlementDrain(): Promise<void> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    for (;;) {
      const count = await this.prisma.settlementEvent.count({ where: { status: 'PENDING' } });
      if (count === 0) return;
      if (Date.now() > deadline) {
        this.logger.error(
          `boot recovery: settlement PENDING drain timed out after ${DRAIN_TIMEOUT_MS}ms ` +
            `(${count} events still pending)`,
        );
        return;
      }
      await sleep(DRAIN_POLL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
