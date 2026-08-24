import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SESSION_TTL_SECONDS } from '@app/core-domain/auth/session.config';
import { UserStreamService } from './user-stream.service';
import { ListenKeyService } from './listen-key.service';

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET is required');

@Module({
  imports: [
    JwtModule.register({
      secret,
      signOptions: { expiresIn: SESSION_TTL_SECONDS },
    }),
  ],
  // WsUserGateway는 WsModule(앱 계층) 소관 — 이 모듈은 settle 프로세스에서도 임포트된다 (M1).
  providers: [UserStreamService, ListenKeyService],
  exports: [UserStreamService, ListenKeyService, JwtModule],
})
export class UserStreamModule {}
