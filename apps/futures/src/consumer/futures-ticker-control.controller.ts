import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { MarketType } from '@prisma/client';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { ControlOp } from '@app/infra/messaging/topics';

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
 * 컨트롤 토픽 소비 — 신규 상장(add)을 meta 캐시에 즉시 반영(재시작 불필요).
 * 엔진도 같은 토픽을 소비해 lane을 추가한다(별도 consumer group).
 */
@Controller()
export class FuturesTickerControlController {
  constructor(private readonly tickerStats: TickerStatsService) {}

  @EventPattern('match.futures.control')
  handle(@Payload() msg: TickerControlMsg): void {
    if (msg.op !== ControlOp.ADD_TICKER) return;
    this.tickerStats.upsertMetaFromControl(MarketType.FUTURES, msg);
  }
}
