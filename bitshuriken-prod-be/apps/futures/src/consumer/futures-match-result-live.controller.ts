import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { MarketType, OrderType, TimeInForce } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { Op } from '@app/infra/messaging/topics';
import {
  OrderUpdateData,
  parseOrderUpdateMsg,
  parseTradeMsg,
} from '@app/infra/messaging/match-message.parser';
import { FuturesUserEventsService } from '../user-events/futures-user-events.service';
import { TERMINAL_FUTURES_ORDER_STATUSES } from './futures-match-result.service';

const MARKET = MarketType.FUTURES;
const SEEN_TRADES_CAP = 8192;

/**
 * API 프로세스 잔류 경량 out-컨슈머 (M1) — spot의 MatchResultLiveController와 동일 역할.
 * DB 쓰기 0: TR → 24h 통계·fmarket 팬아웃, OU → user-events executionReport(주문 행 read +
 * OU 메시지 값 합성; per-fill/realizedPnl은 settle의 insert와 경합하므로 v1에선 null).
 */
@Controller()
export class FuturesMatchResultLiveController {
  private readonly logger = new Logger(FuturesMatchResultLiveController.name);
  private readonly seenTrades = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tickerStats: TickerStatsService,
    private readonly userEvents: FuturesUserEventsService,
  ) {}

  @MessagePattern('match.futures.out')
  async handleFuturesOut(@Payload() payload: { op?: string }): Promise<void> {
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
    if (!order) return;
    const meta = this.tickerStats.metaOf(MARKET, order.tickerSymbol);
    if (!meta) {
      this.logger.error(`no ticker meta for ${MARKET}/${order.tickerSymbol}`);
      return;
    }
    let status = update.status;
    if (
      status === 'PARTIAL' &&
      (order.type === OrderType.MARKET || order.timeInForce === TimeInForce.IOC)
    ) {
      status = 'EXPIRED';
    }
    const wasTerminal = TERMINAL_FUTURES_ORDER_STATUSES.has(order.status);
    this.userEvents.emitExecutionReport(order.userId, {
      orderId: order.id,
      clientOrderId: order.clientOrderId ?? undefined,
      symbol: order.tickerSymbol,
      side: order.side,
      type: order.type,
      timeInForce: order.timeInForce,
      price: order.price !== null ? order.price.toFixed(meta.pricePrecision) : undefined,
      origQty: order.origQty !== null ? order.origQty.toFixed(meta.qtyPrecision) : undefined,
      executedQty: update.executedQty.toFixed(meta.qtyPrecision),
      cumulativeQuoteQty: update.cumulativeQuoteQty.toFixed(meta.pricePrecision),
      status: wasTerminal ? order.status : status,
      reduceOnly: order.reduceOnly,
      lastFilledQty: null,
      lastFilledPrice: null,
      commission: null,
      commissionAsset: null,
      tradeId: null,
      realizedPnl: null,
      ts: update.ts,
    });
  }
}
