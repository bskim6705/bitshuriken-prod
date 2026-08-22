import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { ApiKeyModule } from '../api-key/api-key.module';
import { UserModule } from '../user/user.module';
import { MailModule } from '../mail/mail.module';
import { TwoFactorModule } from '../two-factor/two-factor.module';
import { AuthService } from './auth.service';
import { AuthSessionService } from './auth-session.service';
import { SessionService } from './session.service';
import { JwtStrategy } from './jwt.strategy';
import { JwtOnlyGuard } from './guards/jwt-only.guard';
import { ApiKeyOnlyGuard } from './guards/api-key-only.guard';
import { PrivateGuard } from './guards/private.guard';
import { AdminGuard } from './guards/admin.guard';
import { ServiceOrAdminGuard } from './guards/service-or-admin.guard';
import { SESSION_TTL_SECONDS } from './session.config';

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET is required');

@Module({
  imports: [
    PrismaModule,
    PassportModule,
    JwtModule.register({
      secret,
      signOptions: { expiresIn: SESSION_TTL_SECONDS },
    }),
    ApiKeyModule,
    UserModule,
    MailModule,
    TwoFactorModule,
  ],
  providers: [
    AuthService,
    AuthSessionService,
    SessionService,
    JwtStrategy,
    JwtOnlyGuard,
    ApiKeyOnlyGuard,
    PrivateGuard,
    AdminGuard,
    ServiceOrAdminGuard,
  ],
  exports: [
    AuthService,
    AuthSessionService,
    SessionService,
    JwtOnlyGuard,
    ApiKeyOnlyGuard,
    PrivateGuard,
    AdminGuard,
    ServiceOrAdminGuard,
  ],
})
export class AuthModule {}
