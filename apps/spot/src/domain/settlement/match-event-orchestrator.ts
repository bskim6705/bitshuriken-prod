import { Injectable, Logger } from '@nestjs/common';
import { MarketType, Order, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { SettlementService } from './settlement.service';
import { TickerMeta, TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { UserStreamService } from '../user-stream/user-stream.service';
import { OrderListService } from '../order-list/order-list.service';
import { isMarketLike } from '@app/shared/order-classify';
import { buildExecutionReport, FillDetail } from '../order/execution-report';
import { OrderUpdateData, TradeData } from '@app/infra/messaging/match-message.parser';

const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);

/** spot 매칭 결과(TR/OU) 처리 orchestrator — 정산 기록·주문 상태·OCO·stats·user-stream 위임. */
@Injectable()
export class MatchEventOrchestrator {
  private readonly logger = new Logger(MatchEventOrchestrator.name);

  constructor(
    private prisma: PrismaService,
    private settlement: SettlementService,
    private tickerStats: TickerStatsService,
    private userStream: UserStreamService,
    private orderLists: OrderListService,
  ) {}

  /**
   * TR 처리: settlement event append 후 OCO 컨틴전시 처리, 신규 trade면 stats 반영.
   * wallet/order qty 변동은 worker가 비동기 반영.
   */
  async handleTrade(market: MarketType, trade: TradeData): Promise<void> {
    const ticker = await this.prisma.ticker.findUnique({
      where: { symbol_marketType: { symbol: trade.symbol, marketType: market } },
    });
    if (!ticker) {
      this.logger.error(`unknown ticker ${market}/${trade.symbol}`);
      return;
    }

    const inserted = await this.settlement.recordTrade({
      tradeId: trade.tradeId,
      market,
      tickerSymbol: trade.symbol,
      baseAssetSymbol: ticker.baseAssetSymbol,
      quoteAssetSymbol: ticker.quoteAssetSymbol,
      makerOrderId: trade.makerOrderId,
      takerOrderId: trade.takerOrderId,
      makerUserId: trade.makerUserId,
      takerUserId: trade.takerUserId,
      takerSide: trade.takerSide,
      price: trade.price,
      qty: trade.qty,
      ts: trade.ts,
    });

    // OCO 레그 체결 — 반대 레그 취소가 trigger 평가(applyTrade)보다 먼저 끝나야 한다.
    // 중복 TR에도 실행 (직전 처리가 insert 후 죽었을 수 있음 — guarded 전이로 멱등)
    const legs = await this.prisma.order.findMany({
      where: { id: { in: [trade.makerOrderId, trade.takerOrderId] }, orderListId: { not: null } },
      select: { id: true },
    });
    for (const leg of legs) {
      await this.orderLists.onLegExecuted(leg.id);
    }

    // 중복 TR(엔진 replay)은 24h 통계 재집계·@trade 재방송 금지
    if (inserted) {
      this.tickerStats.applyTrade({
        market,
        symbol: trade.symbol,
        tradeId: trade.tradeId,
        price: trade.price,
        qty: trade.qty,
        takerSide: trade.takerSide,
        ts: trade.ts,
      });
    }
  }

  /**
   * OU 처리: executionReport 발행(모든 OU) + status 동기 기록 + terminal이면 환불/리스트 위임.
   * eq/cqq 의사결정은 OU 메시지 값 사용 (DB는 worker가 비동기 반영 — 즉시성 없음).
   */
  async handleOrderUpdate(market: MarketType, update: OrderUpdateData): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: update.orderId },
    });
    if (!order) {
      this.logger.error(`unknown order ${update.orderId}`);
      return;
    }

    // meta 조회는 어떤 쓰기보다 먼저 — 실패 시 아무것도 커밋되지 않아 재처리 가능.
    const meta = this.tickerStats.metaOf(market, order.tickerSymbol);
    if (!meta) {
      this.logger.error(`no ticker meta for ${market}/${order.tickerSymbol}`);
      return;
    }

    // MARKET/IOC taker 부분체결의 최종 OU는 P — 종결(EXPIRED)로 매핑 (Binance 의미론).
    // LIMIT GTC의 P는 비종결 PARTIAL 그대로.
    let status = update.status;
    if (status === 'PARTIAL' && (isMarketLike(order.type) || order.timeInForce === 'IOC')) {
      status = 'EXPIRED';
    }

    const wasTerminal = TERMINAL_STATUSES.has(order.status);
    const isTerminal = TERMINAL_STATUSES.has(status);

    // 체결 동반 OU면 직전 trade row에서 per-fill 디테일을 끌어와 report에 싣는다.
    const fill = update.executedQty.gt(0)
      ? await this.lastFillOf(market, order.tickerSymbol, order.id, order.userId)
      : undefined;

    if (isTerminal && order.orderListId === null) {
      if (wasTerminal) {
        // 재전달: status는 이미 terminal — 환불 INSERT만 재시도 (sourceKey unique 멱등).
        // 직전 처리에서 status 커밋 후 환불 전에 죽었어도 여기서 복구된다.
        await this.recordDustRefund(market, order, update, meta);
      } else {
        // terminal 기록 + 환불 INSERT를 한 트랜잭션으로 — 둘 사이 크래시 시 환불 유실 방지
        await this.prisma.$transaction(async (tx) => {
          await tx.order.update({ where: { id: update.orderId }, data: { status } });
          await this.recordDustRefund(market, order, update, meta, tx);
        });
      }
    } else if (!wasTerminal) {
      await this.prisma.order.update({
        where: { id: update.orderId },
        data: { status },
      });
    }

    // 모든 OU마다 발행 (status 무변경 P 반복·replay 중복 포함 — 표시 전용이라 허용). eq/cqq는 OU 메시지 값.
    this.userStream.emitExecutionReport(
      order.userId,
      buildExecutionReport(order, meta, {
        executedQty: update.executedQty,
        cumulativeQuoteQty: update.cumulativeQuoteQty,
        status: wasTerminal ? order.status : status,
        ts: update.ts,
        fill,
      }),
    );

    // OCO 레그는 per-order 환불 금지 — 리스트 상태머신에 위임 (재전달 포함, guarded 전이로 멱등)
    if (isTerminal && order.orderListId !== null) {
      await this.orderLists.onLegTerminal(order.orderListId, {
        orderId: order.id,
        eq: update.executedQty,
        cqq: update.cumulativeQuoteQty,
      });
    }
  }

  /**
   * 주문의 가장 최근 trade row에서 per-fill 디테일을 뽑는다 (maker/taker는 userId로 판별).
   * trade row가 아직 없으면(레이스) undefined — report는 누적 필드만 싣는다.
   */
  private async lastFillOf(
    market: MarketType,
    symbol: string,
    orderId: string,
    userId: string,
  ): Promise<FillDetail | undefined> {
    const trade = await this.prisma.trade.findFirst({
      where: {
        tickerSymbol: symbol,
        tickerMarket: market,
        OR: [{ makerOrderId: orderId }, { takerOrderId: orderId }],
      },
      orderBy: { seq: 'desc' },
    });
    if (!trade) return undefined;

    const isMaker = trade.makerUserId === userId;
    const commission = isMaker ? trade.makerCommission : trade.takerCommission;
    const commissionAsset = isMaker ? trade.makerCommissionAsset : trade.takerCommissionAsset;
    if (commissionAsset === null) return undefined;

    return {
      lastFilledQty: trade.qty,
      lastFilledPrice: trade.price,
      commission,
      commissionAsset,
      tradeId: trade.id,
    };
  }

  private recordDustRefund(
    market: MarketType,
    order: Order,
    update: OrderUpdateData,
    meta: TickerMeta,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.settlement.recordDustRefund(
      {
        orderId: order.id,
        userId: order.userId,
        market,
        baseAssetSymbol: meta.baseAsset,
        quoteAssetSymbol: meta.quoteAsset,
        type: order.type,
        side: order.side,
        price: order.price,
        origQty: order.origQty,
        origQuoteQty: order.origQuoteQty,
        cumulativeQuoteQty: update.cumulativeQuoteQty,
        executedQty: update.executedQty,
      },
      tx,
    );
  }
}
