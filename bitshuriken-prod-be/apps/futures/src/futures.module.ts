import { Module } from '@nestjs/common';
import { FuturesConfigModule } from './config/futures-config.module';
import { PositionModule } from './position/position.module';
import { MarkPriceModule } from './mark-price/mark-price.module';
import { FuturesTriggerModule } from './trigger/futures-trigger.module';
import { FuturesAccountModule } from './http/account/futures-account.module';
import { FuturesMarketModule } from './http/market/futures-market.module';
import { FuturesTradingModule } from './http/trading/futures-trading.module';
import { FuturesWsModule } from './http/ws/futures-ws.module';
import { FuturesConsumerModule } from './consumer/futures-consumer.module';
import { FundingModule } from './funding/funding.module';
import { LiquidationModule } from './liquidation/liquidation.module';
import { NetWorthModule } from './net-worth/net-worth.module';

/**
 * futures 전체를 묶는 단일 barrel — FuturesAppModule이 import.
 * consumer의 @MessagePattern은 이 모듈이 로드될 때만 Kafka microservice에 등록된다.
 */
@Module({
  imports: [
    FuturesConfigModule,
    PositionModule,
    MarkPriceModule,
    FuturesTriggerModule,
    FuturesAccountModule,
    FuturesMarketModule,
    FuturesTradingModule,
    FuturesWsModule,
    FuturesConsumerModule,
    FundingModule,
    LiquidationModule,
    NetWorthModule,
  ],
})
export class FuturesModule {}
