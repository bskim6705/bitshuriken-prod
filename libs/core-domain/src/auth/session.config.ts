import type { CookieOptions } from 'express';

// Session TTL. JWT expiresIn(auth.module.ts) + 쿠키 maxAge 공통 출처.
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

export const SESSION_COOKIE_NAME = 'bs_session';

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}
