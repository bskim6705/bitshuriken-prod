import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import * as crypto from 'crypto';
import { UserRole } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { JwtOnlyGuard } from './jwt-only.guard';

/**
 * 머신/세션 겸용 admin 가드 — ticker(리스팅/디리스팅) 같은 비-자금 운영용.
 * - `X-Admin-Secret` 헤더가 있으면 ADMIN_API_SECRET과 상수시간 비교(스크립트/봇 경로, 2FA·세션 불필요).
 * - 없으면 세션 admin 경로(JwtOnlyGuard + DB role 재조회).
 * 자금 이동(credit/debit 등)에는 쓰지 않는다 — 그쪽은 세션+2FA(AdminGuard) 전용.
 */
@Injectable()
export class ServiceOrAdminGuard implements CanActivate {
  constructor(
    private readonly jwtOnly: JwtOnlyGuard,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: CurrentUserPayload }>();

    const provided = req.header('x-admin-secret');
    if (provided) {
      const secret = process.env.ADMIN_API_SECRET;
      if (!secret)
        throw new DomainException(
          ErrorCode.INTERNAL_ERROR,
          'ADMIN_API_SECRET is not configured',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      const a = Buffer.from(provided);
      const b = Buffer.from(secret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
        throw new DomainException(
          ErrorCode.ADMIN_REQUIRED,
          'Invalid admin secret',
          HttpStatus.FORBIDDEN,
        );
      // service principal — userId 없음(자금/2FA 경로에는 사용 불가)
      req.user = { userId: 'service', email: 'service', role: UserRole.ADMIN };
      return true;
    }

    // 세션 admin 경로 — DB role 재조회(토큰 클레임 불신)
    const passed = await (this.jwtOnly.canActivate(ctx) as Promise<boolean>);
    if (!passed) return false;
    const userId = req.user?.userId;
    const user = userId
      ? await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
      : null;
    if (!user || user.role !== UserRole.ADMIN)
      throw new DomainException(
        ErrorCode.ADMIN_REQUIRED,
        'Admin privileges required',
        HttpStatus.FORBIDDEN,
      );
    return true;
  }
}
