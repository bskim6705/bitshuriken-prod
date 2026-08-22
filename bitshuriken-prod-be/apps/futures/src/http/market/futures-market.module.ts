import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { OrderBookModule } from '@app/core-domain/orderbook/orderbook.module';
import { KlineModule } from '@app/core-domain/kline/kline.module';
import { MarkPriceModule } from '../../mark-price/mark-price.module';
import { FuturesConfigModule } from '../../config/futures-config.module';
import { FuturesMarketController } from './futures-market.controller';

@Module({
  imports: [
    PrismaModule,
    TickerModule,
    OrderBookModule,
    KlineModule,
    MarkPriceModule,
    FuturesConfigModule,
  ],
  controllers: [FuturesMarketController],
})
export class FuturesMarketModule {}
