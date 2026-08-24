import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { MarketType } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { Op } from '@app/infra/messaging/topics';
import {
  OrderUpdateData,
  parseOrderUpdateMsg,
  parseTradeMsg,
} from '@app/infra/messaging/match-message.parser';
import { isMarketLike } from '@app/shared/order-classify';
import { UserStreamService } from '../domain/user-stream/user-stream.service';
import { buildExecutionReport } from '../domain/order/execution-report';
import { TERMINAL_ORDER_STATUSES } from '../domain/settlement/match-event-orchestrator';

const MARKET = MarketType.SPOT;
// 엔진 crash-replay 중복 TR 대비 인메모리 디덥 (DB 게이트는 settle 프로세스 소관이 됨).
const SEEN_TRADES_CAP = 8192;

/**
 * API 프로세스 잔류 경량 out-컨슈머 (M1): DB 쓰기 0. 인메모리 효과만 —
 * TR → 24h 통계·@trade 팬아웃·트리거 클록 (tickerStats.applyTrade),
 * OU → user-stream executionReport (주문 행 read + OU 메시지 값으로 합성).
 * DB 효과(Trade/SettlementEvent/Order.status/OCO/정산)는 settle 프로세스의
 * bitshuriken-settle 그룹이 같은 토픽을 독립 오프셋으로 처리한다.
 * 한계(v1): per-fill 디테일은 settle의 Trade insert와 경합해 자주 생략된다 (표시 전용).
 */
@Controller()
export class MatchResultLiveController {
  private readonly logger = new Logger(MatchResultLiveController.name);
  private readonly seenTrades = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tickerStats: TickerStatsService,
    private readonly userStream: UserStreamService,
  ) {}

  @MessagePattern('match.spot.out')
  async handleSpotOut(@Payload() payload: { op?: string }): Promise<void> {
    switch (payload.op) {
      case Op.TRADE: {
        const trade = parseTradeMsg(payload);
        if (this.seenTrades.has(trade.tradeId)) return;
        this.seenTrades.add(trade.tradeId);
        if (this.seenTrades.size > SEEN_TRADES_CAP) {
          const oldest = this.seenTrades.values().next().value;
          if (oldest !== undefined) this.seenTrades.delete(oldest);
        }
        this.tickerStats.applyTrade({
          market: MARKET,
          symbol: trade.symbol,
          tradeId: trade.tradeId,
          price: trade.price,
          qty: trade.qty,
          takerSide: trade.takerSide,
          ts: trade.ts,
        });
        break;
      }
      case Op.ORDER_UPDATE:
        await this.emitReport(parseOrderUpdateMsg(payload));
        break;
      default:
        break;
    }
  }

  private async emitReport(update: OrderUpdateData): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: update.orderId } });
    if (!order) return; // settle의 insert보다 앞선 레이스는 없다 — 주문 행은 place가 만든다
    const meta = this.tickerStats.metaOf(MARKET, order.tickerSymbol);
    if (!meta) {
      this.logger.error(`no ticker meta for ${MARKET}/${order.tickerSymbol}`);
      return;
    }
    // settle과 동일한 종결 매핑 (표시 전용 — DB 상태 전이는 settle 소관)
    let status = update.status;
    if (status === 'PARTIAL' && (isMarketLike(order.type) || order.timeInForce === 'IOC')) {
      status = 'EXPIRED';
    }
    this.userStream.emitExecutionReport(
      order.userId,
      buildExecutionReport(order, meta, {
        executedQty: update.executedQty,
        cumulativeQuoteQty: update.cumulativeQuoteQty,
        status: TERMINAL_ORDER_STATUSES.has(order.status) ? order.status : status,
        ts: update.ts,
      }),
    );
  }
}
