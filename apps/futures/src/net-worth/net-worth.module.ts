import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { MarkPriceModule } from '../mark-price/mark-price.module';
import { NetWorthSnapshotService } from './net-worth-snapshot.service';

@Module({
  imports: [PrismaModule, MarkPriceModule],
  providers: [NetWorthSnapshotService],
  exports: [NetWorthSnapshotService],
})
export class NetWorthModule {}
