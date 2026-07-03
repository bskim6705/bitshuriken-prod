import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { UserModule } from '@app/core-domain/user/user.module';
import { FuturesConfigModule } from '../../config/futures-config.module';
import { PositionModule } from '../../position/position.module';
import { MarkPriceModule } from '../../mark-price/mark-price.module';
import { MarginModule } from '../../margin/margin.module';
import { FuturesTriggerRegistryModule } from '../../trigger/futures-trigger-registry.module';
import { FuturesUserEventsModule } from '../../user-events/futures-user-events.module';
import { FuturesTradingController } from './futures-trading.controller';
import { FuturesTradingService } from './futures-trading.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    TickerModule,
    UserModule,
    FuturesConfigModule,
    PositionModule,
    MarkPriceModule,
    MarginModule,
    FuturesTriggerRegistryModule,
    FuturesUserEventsModule,
  ],
  controllers: [FuturesTradingController],
  providers: [FuturesTradingService],
})
export class FuturesTradingModule {}
