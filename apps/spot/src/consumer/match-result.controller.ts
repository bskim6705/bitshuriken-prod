import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { MarketType } from '@prisma/client';
import { MatchEventOrchestrator } from '../domain/settlement/match-event-orchestrator';
import { Op } from '@app/infra/messaging/topics';
import { parseOrderUpdateMsg, parseTradeMsg } from '@app/infra/messaging/match-message.parser';

/**
 * Settlement hot-path. 여기서는 파싱만 — 처리(정산/상태/OCO/stats/user-stream)는 orchestrator.
 * TR 처리 시 market-data fanout 인라인 금지 — tickerStats가 EventEmitter로 비동기 전달.
 */
@Controller()
export class MatchResultController {
  constructor(private readonly orchestrator: MatchEventOrchestrator) {}

  @MessagePattern('match.spot.out')
  handleSpotOut(@Payload() payload: { op?: string }) {
    return this.dispatch('SPOT', payload);
  }

  private async dispatch(market: MarketType, payload: { op?: string }): Promise<void> {
    switch (payload.op) {
      case Op.TRADE:
        await this.orchestrator.handleTrade(market, parseTradeMsg(payload));
        break;
      case Op.ORDER_UPDATE:
        await this.orchestrator.handleOrderUpdate(market, parseOrderUpdateMsg(payload));
        break;
      default:
        break;
    }
  }
}
