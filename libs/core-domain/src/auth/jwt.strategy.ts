import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserRole } from '@prisma/client';
import { AuthSessionService } from './auth-session.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(session: AuthSessionService) {
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

  // 기존 세션 토큰(role 클레임 없음)은 USER로 폴백. 권한 판정은 AdminGuard의 DB 재조회가 담당.
  validate(payload: { sub: string; email: string; role?: UserRole }) {
    return { userId: payload.sub, email: payload.email, role: payload.role ?? UserRole.USER };
  }
}
