import * as crypto from 'crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { INestApplication } from '@nestjs/common';
import type { ApiResponse } from '@app/shared/interfaces/api-response';
import { SESSION_COOKIE_NAME } from '@app/core-domain/auth/session.config';

export interface AuthData {
  accessToken: string;
  userId: string;
}

/** set-cookie 헤더에서 세션 JWT 추출 (토큰은 body가 아니라 httpOnly 쿠키로 내려온다) */
export function extractSessionToken(setCookie: string | string[] | undefined): string | null {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of cookies) {
    if (c.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      return decodeURIComponent(c.slice(SESSION_COOKIE_NAME.length + 1).split(';')[0]);
    }
  }
  return null;
}

export interface IssuedApiKey {
  id: string;
  apiKey: string;
  secret: string;
  label: string | null;
  canTrade: boolean;
  canRead: boolean;
  createdAt: string;
}

/** signup → 세션 쿠키의 JWT (이메일은 호출 시점 timestamp로 unique 보장 권장) */
export async function signup(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<AuthData> {
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({ email, password })
    .expect(201);
  const body = res.body as ApiResponse<{ id: string }>;
  const accessToken = extractSessionToken(res.headers['set-cookie']);
  if (!body.data || !accessToken) throw new Error('signup did not set session cookie');
  return { accessToken, userId: body.data.id };
}

/** JWT로 API key 발급 */
export async function issueApiKey(
  app: INestApplication<App>,
  jwt: string,
  params: { label?: string; canTrade?: boolean; canRead?: boolean } = {},
): Promise<IssuedApiKey> {
  const res = await request(app.getHttpServer())
    .post('/auth/api-keys')
    .set('Authorization', `Bearer ${jwt}`)
    .send(params)
    .expect(201);
  const body = res.body as ApiResponse<IssuedApiKey>;
  if (!body.data) throw new Error('issueApiKey did not return data');
  return body.data;
}

/** HMAC-SHA256(queryString + body, secret), hex */
export function sign(secret: string, queryString: string, body = ''): string {
  return crypto
    .createHmac('sha256', secret)
    .update(queryString + body)
    .digest('hex');
}

/**
 * API key + signature가 박힌 URL을 만들고 supertest agent를 반환.
 * 호출자는 .set('X-API-KEY', ...) 추가해서 사용.
 */
export function buildSignedUrl(
  basePath: string,
  secret: string,
  extraQuery: Record<string, string> = {},
  body = '',
): string {
  const ts = Date.now();
  const params = new URLSearchParams({ ...extraQuery, timestamp: String(ts) });
  const qs = params.toString();
  const sig = sign(secret, qs, body);
  return `${basePath}?${qs}&signature=${sig}`;
}
