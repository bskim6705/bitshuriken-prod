import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { TotpModule } from '../totp/totp.module';
import { TwoFactorService } from './two-factor.service';

@Module({
  imports: [PrismaModule, CryptoModule, TotpModule],
  providers: [TwoFactorService],
  exports: [TwoFactorService],
})
export class TwoFactorModule {}
