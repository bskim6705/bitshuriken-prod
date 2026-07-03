import { Module } from '@nestjs/common';
import { OrderBookModule } from '@app/core-domain/orderbook/orderbook.module';
import { WsModule } from '../http/ws/ws.module';
import { MarketDataController } from './market-data.controller';

@Module({
  imports: [OrderBookModule, WsModule],
  controllers: [MarketDataController],
})
export class MarketDataModule {}
