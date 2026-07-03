import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from './session.config';

@Injectable()
export class AuthSessionService {
  readonly cookieName = SESSION_COOKIE_NAME;
  private readonly options = sessionCookieOptions();

  setSession(res: Response, token: string): void {
    res.cookie(this.cookieName, token, this.options);
  }

  clearSession(res: Response): void {
    const { httpOnly, secure, sameSite, path } = this.options;
    res.clearCookie(this.cookieName, { httpOnly, secure, sameSite, path });
  }

  extractToken(req: Request): string | null {
    const cookies = (req as { cookies?: unknown }).cookies;
    if (!cookies || typeof cookies !== 'object') return null;
    const token = (cookies as Record<string, unknown>)[this.cookieName];
    return typeof token === 'string' ? token : null;
  }
}
