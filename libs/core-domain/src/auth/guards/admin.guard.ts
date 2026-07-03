import { CanActivate, ExecutionContext, Injectable, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UserRole } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { ROLES_KEY } from '@app/shared/decorators/roles.decorator';
import { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';

/**
 * Role 강제 가드. JwtOnlyGuard 다음에 실행(req.user 필요).
 * 토큰의 role 클레임을 믿지 않고 DB의 User.role을 재조회 — 강등/회수 즉시 반영.
 * @Roles 미지정 핸들러는 통과(인증만 보장).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: CurrentUserPayload }>();
    const userId = req.user?.userId;
    if (!userId)
      throw new DomainException(
        ErrorCode.AUTH_REQUIRED,
        'Authentication required',
        HttpStatus.UNAUTHORIZED,
      );

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user || !required.includes(user.role))
      throw new DomainException(
        ErrorCode.ADMIN_REQUIRED,
        'Admin privileges required',
        HttpStatus.FORBIDDEN,
      );

    return true;
  }
}
