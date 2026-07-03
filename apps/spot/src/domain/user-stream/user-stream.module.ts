import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SESSION_TTL_SECONDS } from '@app/core-domain/auth/session.config';
import { WsUserGateway } from '../../http/ws/user.gateway';
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
  providers: [UserStreamService, ListenKeyService, WsUserGateway],
  exports: [UserStreamService, ListenKeyService],
})
export class UserStreamModule {}
