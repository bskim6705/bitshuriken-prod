import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { FuturesConfigModule } from '../config/futures-config.module';
import { MarkPriceModule } from '../mark-price/mark-price.module';
import { InsuranceFundModule } from '../settlement/insurance-fund.module';
import { FuturesUserEventsModule } from '../user-events/futures-user-events.module';
import { LiquidationMonitor } from './liquidation.monitor';
import { LiquidationExecutor } from './liquidation-executor';

@Module({
  imports: [
    PrismaModule,
    TickerModule,
    FuturesConfigModule,
    MarkPriceModule,
    InsuranceFundModule,
    FuturesUserEventsModule,
  ],
  providers: [LiquidationMonitor, LiquidationExecutor],
})
export class LiquidationModule {}
