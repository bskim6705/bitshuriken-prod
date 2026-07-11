import { Module } from '@nestjs/common';
import { AuthModule as AuthCoreModule } from '@app/core-domain/auth/auth.module';
import { ApiKeyModule } from '@app/core-domain/api-key/api-key.module';
import { TwoFactorModule } from '@app/core-domain/two-factor/two-factor.module';
import { NotifyModule } from '../../notify/notify.module';
import { AuthController } from './auth.controller';
import { ApiKeysController } from './api-keys/api-keys.controller';
import { PasswordController } from './password.controller';
import { TwoFactorController } from './two-factor.controller';
import { SecurityController } from './security.controller';

@Module({
  imports: [AuthCoreModule, ApiKeyModule, TwoFactorModule, NotifyModule],
  controllers: [
    AuthController,
    ApiKeysController,
    PasswordController,
    TwoFactorController,
    SecurityController,
  ],
})
export class AuthHttpModule {}
