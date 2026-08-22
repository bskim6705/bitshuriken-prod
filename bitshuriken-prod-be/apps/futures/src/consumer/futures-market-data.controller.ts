import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { MarketType } from '@prisma/client';
import { OrderBookCacheService } from '@app/core-domain/orderbook/orderbook-cache.service';
import { Op } from '@app/infra/messaging/topics';
import { parseDepthDiffMsg } from '@app/infra/messaging/match-message.parser';
import { WsFuturesMarketGateway } from '../http/ws/futures-market.gateway';

const MARKET: MarketType = 'FUTURES';

@Controller()
export class FuturesMarketDataController {
  constructor(
    private readonly obCache: OrderBookCacheService,
    private readonly gateway: WsFuturesMarketGateway,
  ) {}

  @MessagePattern('match.futures.book')
  handleFuturesBook(@Payload() payload: { op?: string }) {
    if (payload.op === Op.DEPTH_DIFF) {
      const diff = parseDepthDiffMsg(payload);
      this.obCache.applyDiff(MARKET, diff);
      this.gateway.onDepthDiff(MARKET, diff.symbol);
    }
  }
}
