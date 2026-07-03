import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { UserModule } from '@app/core-domain/user/user.module';
import { UserStreamModule } from '../user-stream/user-stream.module';
import { SettlementService } from './settlement.service';
import { SettlementWorker } from './settlement.worker';

@Module({
  imports: [PrismaModule, UserModule, UserStreamModule],
  providers: [SettlementService, SettlementWorker],
  exports: [SettlementService],
})
export class SettlementModule {}
