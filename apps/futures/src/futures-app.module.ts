import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { KafkaModule } from '@app/infra/messaging/kafka.module';
import { RateLimitModule } from '@app/shared/rate-limit/rate-limit.module';
import { FuturesModule } from './futures.module';

// cross-product 도메인(auth/user/ticker/orderbook/kline)은 각 futures 모듈이 직접 import한다.
@Module({
  imports: [
    ScheduleModule.forRoot(),
    RateLimitModule.forApp('futures'),
    PrismaModule,
    KafkaModule,
    FuturesModule,
  ],
})
export class FuturesAppModule {}
