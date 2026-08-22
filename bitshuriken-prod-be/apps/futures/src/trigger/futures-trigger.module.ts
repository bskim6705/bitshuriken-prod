import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { UserModule } from '@app/core-domain/user/user.module';
import { MarkPriceModule } from '../mark-price/mark-price.module';
import { MarginModule } from '../margin/margin.module';
import { FuturesConfigModule } from '../config/futures-config.module';
import { PositionModule } from '../position/position.module';
import { FuturesUserEventsModule } from '../user-events/futures-user-events.module';
import { FuturesTriggerRegistryModule } from './futures-trigger-registry.module';
import { FuturesTriggerService } from './futures-trigger.service';
import { FuturesOrderDispatchService } from './futures-order-dispatch.service';

@Module({
  imports: [
    PrismaModule,
    TickerModule,
    UserModule,
    MarkPriceModule,
    MarginModule,
    FuturesConfigModule,
    PositionModule,
    FuturesUserEventsModule,
    FuturesTriggerRegistryModule,
  ],
  providers: [FuturesTriggerService, FuturesOrderDispatchService],
  exports: [FuturesTriggerRegistryModule],
})
export class FuturesTriggerModule {}
