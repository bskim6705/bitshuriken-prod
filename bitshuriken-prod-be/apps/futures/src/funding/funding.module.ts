import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { FuturesConfigModule } from '../config/futures-config.module';
import { MarkPriceModule } from '../mark-price/mark-price.module';
import { FuturesSettlementModule } from '../settlement/futures-settlement.module';
import { FundingScheduler } from './funding.scheduler';

@Module({
  imports: [PrismaModule, FuturesConfigModule, MarkPriceModule, FuturesSettlementModule],
  providers: [FundingScheduler],
})
export class FundingModule {}
