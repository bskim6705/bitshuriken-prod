import { Module } from '@nestjs/common';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { TradeModule } from '../../../../domain/trade/trade.module';
import { OrderBookModule } from '@app/core-domain/orderbook/orderbook.module';
import { KlineModule } from '@app/core-domain/kline/kline.module';
import { MarketController } from './market.controller';

@Module({
  imports: [TickerModule, TradeModule, OrderBookModule, KlineModule],
  controllers: [MarketController],
})
export class MarketModule {}
