import { CanActivate, ExecutionContext, Injectable, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { JwtOnlyGuard } from './jwt-only.guard';
import { ApiKeyOnlyGuard } from './api-key-only.guard';
import { AuthSessionService } from '../auth-session.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

/**
 * Private endpoint 보호 가드. 세션 쿠키 / JWT Bearer / API key 모두 허용.
 *
 * 분기:
 * - X-API-KEY 있으면 → ApiKeyOnlyGuard
 * - 세션 쿠키 or Authorization: Bearer 있으면 → JwtOnlyGuard (전략이 쿠키 우선 추출)
 * - 모두 없으면 401
 *
 * 단일 책임: PrivateGuard는 분기만 한다. 실제 검증은 각 단일 가드의 책임.
 */
@Injectable()
export class PrivateGuard implements CanActivate {
  constructor(
    private readonly jwtOnly: JwtOnlyGuard,
    private readonly apiKeyOnly: ApiKeyOnlyGuard,
    private readonly session: AuthSessionService,
  ) {}

  canActivate(ctx: ExecutionContext): Promise<boolean> | boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (req.header('x-api-key')) {
      return this.apiKeyOnly.canActivate(ctx);
    }
    const hasBearer = req.header('authorization')?.toLowerCase().startsWith('bearer ');
    if (this.session.extractToken(req) !== null || hasBearer) {
      return this.jwtOnly.canActivate(ctx) as boolean | Promise<boolean>;
    }
    throw new DomainException(
      ErrorCode.AUTH_REQUIRED,
      'Authentication required',
      HttpStatus.UNAUTHORIZED,
    );
  }
}
