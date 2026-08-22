import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { UserModule } from '@app/core-domain/user/user.module';
import { UserStreamModule } from '../user-stream/user-stream.module';
import { SettlementModule } from '../settlement/settlement.module';
import { TriggerRegistryModule } from '../trigger/trigger-registry.module';
import { OrderDispatchModule } from '../order/order-dispatch.module';
import { OrderListService } from './order-list.service';
import { OcoStateMachine } from './oco-state-machine';

@Module({
  imports: [
    PrismaModule,
    TickerModule,
    UserModule,
    UserStreamModule,
    SettlementModule,
    TriggerRegistryModule,
    OrderDispatchModule,
  ],
  providers: [OrderListService, OcoStateMachine],
  exports: [OrderListService],
})
export class OrderListModule {}
