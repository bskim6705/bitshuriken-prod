import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { FuturesConfigModule } from '../config/futures-config.module';
import { MarkPriceModule } from '../mark-price/mark-price.module';
import { FuturesUserEventsModule } from '../user-events/futures-user-events.module';
import { InsuranceFundService } from './insurance-fund.service';
import { FuturesSettlementWorker } from './futures-settlement.worker';

@Module({
  imports: [PrismaModule, FuturesConfigModule, MarkPriceModule, FuturesUserEventsModule],
  providers: [FuturesSettlementWorker, InsuranceFundService],
  exports: [InsuranceFundService],
})
export class FuturesSettlementModule {}
