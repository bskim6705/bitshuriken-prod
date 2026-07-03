import { Module } from '@nestjs/common';
import { OrderBookCacheService } from './orderbook-cache.service';

@Module({
  providers: [OrderBookCacheService],
  exports: [OrderBookCacheService],
})
export class OrderBookModule {}
