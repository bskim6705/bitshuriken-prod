import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { MarketType } from '@prisma/client';
import { OrderBookCacheService } from '@app/core-domain/orderbook/orderbook-cache.service';
import { WsMarketGateway } from '../http/ws/market.gateway';
import { Op } from '@app/infra/messaging/topics';
import { parseDepthDiffMsg } from '@app/infra/messaging/match-message.parser';

@Controller()
export class MarketDataController {
  constructor(
    private readonly obCache: OrderBookCacheService,
    private readonly gateway: WsMarketGateway,
  ) {}

  @MessagePattern('match.spot.book')
  handleSpotBook(@Payload() payload: { op?: string }) {
    this.dispatch('SPOT', payload);
  }

  private dispatch(market: MarketType, payload: { op?: string }): void {
    if (payload.op === Op.DEPTH_DIFF) {
      const diff = parseDepthDiffMsg(payload);
      this.obCache.applyDiff(market, diff);
      this.gateway.onDepthDiff(market, diff.symbol, diff);
    }
  }
}
