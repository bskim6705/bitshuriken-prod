import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { TwoFactorModule } from '../two-factor/two-factor.module';
import { ApiKeyService } from './api-key.service';

@Module({
  imports: [PrismaModule, CryptoModule, TwoFactorModule],
  providers: [ApiKeyService],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}
