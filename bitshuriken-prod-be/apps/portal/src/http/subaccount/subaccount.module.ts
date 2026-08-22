import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { ApiKeyModule } from '@app/core-domain/api-key/api-key.module';
import { TwoFactorModule } from '@app/core-domain/two-factor/two-factor.module';
import { SubaccountController } from './subaccount.controller';
import { SubaccountService } from './subaccount.service';

// JournalWriter는 @Global PortalLedgerModule이 제공 (append 전용 배선).
@Module({
  imports: [PrismaModule, AuthModule, ApiKeyModule, TwoFactorModule],
  controllers: [SubaccountController],
  providers: [SubaccountService],
})
export class SubaccountModule {}
