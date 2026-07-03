import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { MarketType } from '@prisma/client';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { Op } from '@app/infra/messaging/topics';
import { parseOrderUpdateMsg, parseTradeMsg } from '@app/infra/messaging/match-message.parser';
import { FuturesMatchResultService } from './futures-match-result.service';

const MARKET: MarketType = MarketType.FUTURES;

/**
 * futures settlement hot-path. TR 처리 시 fanout을 인라인으로 부르지 않는다 —
 * tickerStats가 내부 EventEmitter로 fmarket gateway에 비동기 전달.
 */
@Controller()
export class FuturesMatchResultController {
  constructor(
    private readonly service: FuturesMatchResultService,
    private readonly tickerStats: TickerStatsService,
  ) {}

  @MessagePattern('match.futures.out')
  async handleFuturesOut(@Payload() payload: { op?: string }): Promise<void> {
    switch (payload.op) {
      case Op.TRADE: {
        const trade = parseTradeMsg(payload);
        const inserted = await this.service.handleTrade(trade);
        // 중복 TR(엔진 replay)은 24h 통계 재집계·@trade 재방송 금지
        if (inserted) {
          this.tickerStats.applyTrade({
            market: MARKET,
            symbol: trade.symbol,
            tradeId: trade.tradeId,
            price: trade.price,
            qty: trade.qty,
            takerSide: trade.takerSide,
            ts: trade.ts,
          });
        }
        break;
      }
      case Op.ORDER_UPDATE:
        await this.service.handleOrderUpdate(parseOrderUpdateMsg(payload));
        break;
      default:
        break;
    }
  }
}
