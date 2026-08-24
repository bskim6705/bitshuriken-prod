import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { UserModule } from '@app/core-domain/user/user.module';
import { UserStreamModule } from '../user-stream/user-stream.module';
import { SettlementService } from './settlement.service';

// SettlementWorker는 M1부터 settle 프로세스(SettleWorkersModule)에서만 구동 — 여기선 서비스만.
@Module({
  imports: [PrismaModule, UserModule, UserStreamModule],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
