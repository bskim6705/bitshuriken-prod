import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { KafkaModule } from '@app/infra/messaging/kafka.module';
import { OrderDispatchService } from './order-dispatch.service';

@Module({
  imports: [PrismaModule, KafkaModule],
  providers: [OrderDispatchService],
  exports: [OrderDispatchService],
})
export class OrderDispatchModule {}
