import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { MarketType } from '@prisma/client';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { ControlOp, Op } from '@app/infra/messaging/topics';
import { parseOrderUpdateMsg, parseTradeMsg } from '@app/infra/messaging/match-message.parser';
import { MatchEventOrchestrator } from '../../../spot/src/domain/settlement/match-event-orchestrator';
import { FuturesMatchResultService } from '../../../futures/src/consumer/futures-match-result.service';

interface TickerControlMsg {
  op?: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  qtyPrecision: number;
  minNotional: string;
}

/**
 * settle 프로세스의 out-컨슈머 (그룹 bitshuriken-settle) — DB 효과 전담:
 * Trade/SettlementEvent insert, Order.status 전이, OCO 레그, dust/잔여 환불.
 * 인메모리 효과(24h 통계·WS 팬아웃)는 API 앱들의 경량 그룹 소관 — spot 오케스트레이터가
 * 내부적으로 갱신하는 stats는 이 프로세스 로컬 상태로, 구독자가 없어 무해하다.
 * control 토픽도 소비해 런타임 상장 심볼의 meta를 즉시 안다 (OU 처리의 metaOf 전제).
 */
@Controller()
export class SettleMatchResultController {
  constructor(
    private readonly orchestrator: MatchEventOrchestrator,
    private readonly futures: FuturesMatchResultService,
    private readonly tickerStats: TickerStatsService,
  ) {}

  @MessagePattern('match.spot.out')
  async handleSpotOut(@Payload() payload: { op?: string }): Promise<void> {
    switch (payload.op) {
      case Op.TRADE:
        await this.orchestrator.handleTrade(MarketType.SPOT, parseTradeMsg(payload));
        break;
      case Op.ORDER_UPDATE:
        await this.orchestrator.handleOrderUpdate(MarketType.SPOT, parseOrderUpdateMsg(payload));
        break;
      default:
        break;
    }
  }

  @MessagePattern('match.futures.out')
  async handleFuturesOut(@Payload() payload: { op?: string }): Promise<void> {
    switch (payload.op) {
      case Op.TRADE:
        await this.futures.handleTrade(parseTradeMsg(payload));
        break;
      case Op.ORDER_UPDATE:
        await this.futures.handleOrderUpdate(parseOrderUpdateMsg(payload));
        break;
      default:
        break;
    }
  }

  @EventPattern('match.spot.control')
  handleSpotControl(@Payload() msg: TickerControlMsg): void {
    if (msg.op !== ControlOp.ADD_TICKER) return;
    this.tickerStats.upsertMetaFromControl(MarketType.SPOT, msg);
  }

  @EventPattern('match.futures.control')
  handleFuturesControl(@Payload() msg: TickerControlMsg): void {
    if (msg.op !== ControlOp.ADD_TICKER) return;
    this.tickerStats.upsertMetaFromControl(MarketType.FUTURES, msg);
  }
}
