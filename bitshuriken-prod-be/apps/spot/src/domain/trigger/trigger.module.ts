import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { UserStreamModule } from '../user-stream/user-stream.module';
import { OrderDispatchModule } from '../order/order-dispatch.module';
import { OrderListModule } from '../order-list/order-list.module';
import { TriggerRegistryModule } from './trigger-registry.module';
import { TriggerService } from './trigger.service';

@Module({
  imports: [
    PrismaModule,
    TickerModule,
    UserStreamModule,
    OrderDispatchModule,
    OrderListModule,
    TriggerRegistryModule,
  ],
  providers: [TriggerService],
  exports: [TriggerRegistryModule],
})
export class TriggerModule {}
