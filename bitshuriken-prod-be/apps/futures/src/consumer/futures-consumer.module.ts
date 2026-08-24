import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { OrderBookModule } from '@app/core-domain/orderbook/orderbook.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { UserModule } from '@app/core-domain/user/user.module';
import { FuturesWsModule } from '../http/ws/futures-ws.module';
import { FuturesUserEventsModule } from '../user-events/futures-user-events.module';
import { FuturesMarketDataController } from './futures-market-data.controller';
import { FuturesMatchResultLiveController } from './futures-match-result-live.controller';
import { FuturesTickerControlController } from './futures-ticker-control.controller';

// M1: API 프로세스는 경량 out-컨슈머(인메모리 효과)만 — DB 효과 컨슈머(FuturesMatchResultService)는
// settle 프로세스가 FuturesMatchResultModule로 배선한다.
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
    FuturesMatchResultLiveController,
    FuturesTickerControlController,
  ],
})
export class FuturesConsumerModule {}
