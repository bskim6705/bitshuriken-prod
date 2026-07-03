import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export interface CurrentUserPayload {
  userId: string;
  email: string;
  role: UserRole;
}

/**
 * JwtStrategy.validate가 반환한 payload에서 user 정보를 추출.
 * 사용: `@CurrentUser() user: CurrentUserPayload`
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserPayload => {
    const request = ctx.switchToHttp().getRequest<{ user: CurrentUserPayload }>();
    return request.user;
  },
);
