import { Module } from '@nestjs/common';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { TradeModule } from '../../domain/trade/trade.module';
import { OrderBookModule } from '@app/core-domain/orderbook/orderbook.module';
import { KlineModule } from '@app/core-domain/kline/kline.module';
import { UserStreamModule } from '../../domain/user-stream/user-stream.module';
import { WsMarketGateway } from './market.gateway';
import { WsUserGateway } from './user.gateway';

@Module({
  imports: [TickerModule, TradeModule, OrderBookModule, KlineModule, UserStreamModule],
  providers: [WsMarketGateway, WsUserGateway],
  exports: [WsMarketGateway],
})
export class WsModule {}
