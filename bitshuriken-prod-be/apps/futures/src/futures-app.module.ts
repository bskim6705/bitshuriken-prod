import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { KafkaModule } from '@app/infra/messaging/kafka.module';
import { RateLimitModule } from '@app/shared/rate-limit/rate-limit.module';
import { FuturesModule } from './futures.module';
import { FuturesLedgerModule } from './ledger/futures-ledger.module';

// cross-product 도메인(auth/user/ticker/orderbook/kline)은 각 futures 모듈이 직접 import한다.
@Module({
  imports: [
    ScheduleModule.forRoot(),
    RateLimitModule.forApp('futures'),
    PrismaModule,
    KafkaModule,
    FuturesLedgerModule, // ADR-069 S0: 잔고 저널+원장 섀도 (전역 단일 인스턴스)
    FuturesModule,
  ],
})
export class FuturesAppModule {}
