import { SetMetadata } from '@nestjs/common';

/**
 * Endpoint가 API key 인증에 요구하는 권한 범위.
 * JWT(웹 세션)는 범위 무관 전체 허용 — 범위는 API key 경로에서만 강제.
 */
export enum ApiScope {
  READ = 'read',
  TRADE = 'trade',
}

export const API_SCOPE_KEY = 'apiScope';

/** Endpoint가 요구하는 API key 권한. 미지정 시 READ로 간주. */
export const RequireApiScope = (scope: ApiScope) => SetMetadata(API_SCOPE_KEY, scope);
