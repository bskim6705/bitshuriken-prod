import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { TwoFactorModule } from '@app/core-domain/two-factor/two-factor.module';
import { NotifyModule } from '../../notify/notify.module';
import { FundingController } from './funding.controller';
import { FundingService } from './funding.service';

// JournalWriter는 @Global PortalLedgerModule이 제공 (append 전용 배선).
@Module({
  imports: [PrismaModule, AuthModule, TwoFactorModule, NotifyModule],
  controllers: [FundingController],
  providers: [FundingService],
})
export class FundingModule {}
