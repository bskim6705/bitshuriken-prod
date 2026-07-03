import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Endpoint가 요구하는 user role. AdminGuard가 DB 재조회로 강제한다.
 * 사용: `@Roles(UserRole.ADMIN)` (컨트롤러/핸들러 단위).
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
