import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * JWT 전용 가드 (세션 쿠키 우선, Bearer 폴백 — JwtStrategy 추출 순서).
 * PrivateGuard와 달리 API key를 받지 않는다 (escalation 차단).
 * 통과 시 req.user = { userId, email }.
 */
@Injectable()
export class JwtOnlyGuard extends AuthGuard('jwt') {}
