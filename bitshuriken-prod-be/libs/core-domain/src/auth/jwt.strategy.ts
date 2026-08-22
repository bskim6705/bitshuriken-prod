import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserRole } from '@prisma/client';
import { AuthSessionService } from './auth-session.service';
import { SessionService } from './session.service';

interface JwtPayload {
  sub: string;
  email: string;
  role?: UserRole;
  sid?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    session: AuthSessionService,
    private sessions: SessionService,
  ) {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is required');

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req) => session.extractToken(req),
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      secretOrKey: secret,
    });
  }

  // sid 없는 토큰(구 형식)은 거부 → 재로그인 강제. 서버측 세션이 revoke됐으면 401.
  async validate(payload: JwtPayload) {
    if (!payload.sid || !(await this.sessions.isActive(payload.sid))) {
      throw new UnauthorizedException();
    }
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role ?? UserRole.USER,
      sessionId: payload.sid,
    };
  }
}
