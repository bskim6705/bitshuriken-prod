import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { TwoFactorModule } from '@app/core-domain/two-factor/two-factor.module';
import { FundingController } from './funding.controller';
import { FundingService } from './funding.service';

@Module({
  imports: [PrismaModule, AuthModule, TwoFactorModule],
  controllers: [FundingController],
  providers: [FundingService],
})
export class FundingModule {}
