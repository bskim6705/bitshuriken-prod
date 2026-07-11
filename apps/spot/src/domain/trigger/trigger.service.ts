import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Order } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService, TradeEvent } from '@app/core-domain/ticker/ticker-stats.service';
import { UserStreamService } from '../user-stream/user-stream.service';
import { OrderDispatchService } from '../order/order-dispatch.service';
import { buildExecutionReport } from '../order/execution-report';
import { stopTriggered } from '../order/order-validation';
import { OrderListService } from '../order-list/order-list.service';
import { TriggerRegistryService } from './trigger-registry.service';

const ZERO = new Decimal(0);
const DRAIN_POLL_MS = 500;
const DRAIN_TIMEOUT_MS = 60_000;
const RECOVERY_DELAY_MS = 10_000;
const REDRIVE_DELAY_MS = 5_000;

/**
 * BE 보관 stop 주문의 트리거 평가. 진실은 DB guarded claim — registry는 후보 탐색용.
 * onTrade 리스너의 registry 확인/제거는 어떤 await보다 먼저 동기 실행 (이중 트리거 방지).
 */
@Injectable()
export class TriggerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TriggerService.name);
  private unsubscribe: (() => void) | null = null;
  // 발화 실패한 OCO 레그 — 다음 trade에서 가격 조건 없이 재발화 (전송 유실 복구)
  private readonly ocoRedrive = new Set<string>();

  constructor(
    private prisma: PrismaService,
    private tickerStats: TickerStatsService,
    private registry: TriggerRegistryService,
    private dispatch: OrderDispatchService,
    private orderLists: OrderListService,
    private userStream: UserStreamService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // rehydrate — 컨슈머 시작 전 완료 (TickerStats 패턴과 동일)
    const pending = await this.prisma.order.findMany({
      where: { stopPrice: { not: null }, triggeredAt: null, status: 'NEW' },
    });
    for (const order of pending) this.registry.add(order);
    this.logger.log(`rehydrated ${pending.length} untriggered stop orders`);

    this.unsubscribe = this.tickerStats.onTrade((event) => this.onTrade(event));

    void this.runBootRecovery().catch((e) => {
      this.logger.error('stop/OCO boot recovery failed', e as Error);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  // ---------- trigger evaluation ----------

  private onTrade(event: TradeEvent): void {
    const candidates = this.registry.pendingFor(event.market, event.symbol);
    if (candidates.length === 0) return;

    // claim-before-await: 한 sweep의 다중 TR로 인한 이중 트리거 방지 — 제거까지 동기
    const triggered: Order[] = [];
    for (const order of candidates) {
      if (
        this.ocoRedrive.has(order.id) ||
        stopTriggered(order.type, order.side, order.stopPrice!, event.price)
      ) {
        this.registry.remove(order.id);
        triggered.push(order);
      }
    }

    for (const order of triggered) {
      void this.fire(order).catch((e) => {
        this.logger.error(`failed to fire triggered stop order ${order.id}`, e as Error);
        this.registry.add(order); // 복원 — 다음 trade에서 재시도
        if (order.orderListId !== null) this.ocoRedrive.add(order.id);
      });
    }
  }

  private async fire(order: Order): Promise<void> {
    if (order.orderListId !== null) {
      // delete가 true = 직전 발화가 전송 실패 — 리스트 쪽에 유실 메시지 재드라이브를 지시
      const redrive = this.ocoRedrive.delete(order.id);
      await this.orderLists.onStopTriggered(order, redrive);
      return;
    }

    // guarded claim — 취소와의 레이스 중재
    const claim = await this.prisma.order.updateMany({
      where: { id: order.id, status: 'NEW', triggeredAt: null },
      data: { triggeredAt: new Date() },
    });
    if (claim.count === 0) return; // 취소가 선점

    try {
      await this.dispatch.dispatchNewOrder(order);
    } catch (e) {
      // claim은 유지한 채 주기 재전송 — 실패 시 armed-but-unsent로 부팅까지 고착되는 것 방지
      this.logger.error(
        `failed to send NO for stop order ${order.id} — starting redrive`,
        e as Error,
      );
      void this.redriveArmedNo(order.id);
      return;
    }
    this.emitTriggeredReport(order);
  }

  /** 전송 실패한 armed 주문의 주기 재전송. 취소/OU로 status가 NEW를 벗어나면 중단. */
  private async redriveArmedNo(orderId: string): Promise<void> {
    for (;;) {
      await sleep(REDRIVE_DELAY_MS);
      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order || order.status !== 'NEW' || order.triggeredAt === null) return;
      try {
        await this.dispatch.dispatchNewOrder(order);
      } catch (e) {
        this.logger.error(`NO redrive failed for stop order ${orderId} — retrying`, e as Error);
        continue;
      }
      this.emitTriggeredReport(order);
      return;
    }
  }

  private emitTriggeredReport(order: Order): void {
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
        status: 'NEW',
        ts: Date.now(),
      }),
    );
  }

  // ---------- boot recovery ----------

  /** armed-but-unsent 복구: settlement drain 대기 → +10s → NEW+triggeredAt!=null 재전송. */
  private async runBootRecovery(): Promise<void> {
    await this.waitForSettlementDrain();
    await sleep(RECOVERY_DELAY_MS);

    const armed = await this.prisma.order.findMany({
      where: {
        status: 'NEW',
        triggeredAt: { not: null },
        stopPrice: { not: null },
        orderListId: null,
      },
    });
    for (const order of armed) {
      // Kafka 백로그의 OU가 그 사이 처리됐다면 status가 바뀌어 위 스캔에서 자연 스킵된다.
      this.logger.warn(`boot recovery: re-emitting NO for armed-but-unsent stop order ${order.id}`);
      await this.dispatch.dispatchNewOrder(order);
    }
    if (armed.length === 0) {
      this.logger.log('boot recovery: no armed-but-unsent stop orders');
    }

    await this.orderLists.runBootRecovery();
  }

  private async waitForSettlementDrain(): Promise<void> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    for (;;) {
      const count = await this.prisma.settlementEvent.count({ where: { status: 'PENDING' } });
      if (count === 0) return;
      if (Date.now() > deadline) {
        this.logger.error(
          `boot recovery: settlement PENDING drain timed out after ${DRAIN_TIMEOUT_MS}ms ` +
            `(${count} events still pending) — recovery decisions may use stale eq/cqq`,
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
