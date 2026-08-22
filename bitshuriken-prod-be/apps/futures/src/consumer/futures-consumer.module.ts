import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { OrderBookModule } from '@app/core-domain/orderbook/orderbook.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { UserModule } from '@app/core-domain/user/user.module';
import { FuturesWsModule } from '../http/ws/futures-ws.module';
import { FuturesUserEventsModule } from '../user-events/futures-user-events.module';
import { FuturesMarketDataController } from './futures-market-data.controller';
import { FuturesMatchResultController } from './futures-match-result.controller';
import { FuturesMatchResultService } from './futures-match-result.service';
import { FuturesTickerControlController } from './futures-ticker-control.controller';

@Module({
  imports: [
    PrismaModule,
    OrderBookModule,
    TickerModule,
    UserModule,
    FuturesWsModule,
    FuturesUserEventsModule,
  ],
  controllers: [
    FuturesMarketDataController,
    FuturesMatchResultController,
    FuturesTickerControlController,
  ],
  providers: [FuturesMatchResultService],
})
export class FuturesConsumerModule {}
