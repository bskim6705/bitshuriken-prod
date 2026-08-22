import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { UserModule } from '@app/core-domain/user/user.module';
import { UserStreamModule } from '../user-stream/user-stream.module';
import { SettlementModule } from '../settlement/settlement.module';
import { TriggerModule } from '../trigger/trigger.module';
import { OrderListModule } from '../order-list/order-list.module';
import { OrderDispatchModule } from './order-dispatch.module';
import { OrderService } from './order.service';

@Module({
  imports: [
    PrismaModule,
    TickerModule,
    UserModule,
    UserStreamModule,
    SettlementModule,
    // TriggerModule이 registry를 재노출 + TriggerService를 기동한다
    TriggerModule,
    OrderListModule,
    OrderDispatchModule,
  ],
  providers: [OrderService],
  exports: [OrderService],
})
export class OrderModule {}
