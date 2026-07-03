import { RateLimitLimits, limitsForApp, RateLimitApp } from './rate-limit.defaults';

/**
 * .env에서 오는 값 = 환경/배포별 값만 (토글·시크릿·토폴로지). 정책 수치 한도는 코드(rate-limit.defaults).
 * feedback-020.
 */
export interface RateLimitRuntime {
  enabled: boolean;
  internalToken: string;
  trustProxyHops: number;
  storeMaxKeys: number;
}

/** 인터셉터가 쓰는 유효 config = 코드 한도 + env 런타임. */
export interface RateLimitConfig extends RateLimitLimits, RateLimitRuntime {}

function int(v: string | undefined, dflt: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return v === 'true' || v === '1';
}

export function loadRateLimitRuntime(env: NodeJS.ProcessEnv = process.env): RateLimitRuntime {
  return {
    enabled: bool(env.RATE_LIMIT_ENABLED, false),
    internalToken: env.RATE_LIMIT_INTERNAL_TOKEN ?? '',
    trustProxyHops: int(env.RATE_LIMIT_TRUST_PROXY_HOPS, 0),
    storeMaxKeys: int(env.RATE_LIMIT_STORE_MAX_KEYS, 100000),
  };
}

/** 앱별 코드 한도 + env 런타임을 합쳐 유효 config 생성. */
export function resolveRateLimitConfig(
  app: RateLimitApp,
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  return { ...limitsForApp(app), ...loadRateLimitRuntime(env) };
}

export interface RateLimitDescriptor {
  rateLimitType: 'REQUEST_WEIGHT' | 'ORDERS' | 'RAW_REQUESTS';
  interval: 'SECOND' | 'MINUTE' | 'DAY';
  intervalNum: number;
  limit: number;
}

/** exchange-info의 rateLimits[] (Binance 형식). 앱별 코드 한도에서 생성. */
export function buildRateLimits(limits: RateLimitLimits): RateLimitDescriptor[] {
  return [
    { rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: limits.weightPerMin },
    { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: limits.ordersPer10s },
    { rateLimitType: 'ORDERS', interval: 'DAY', intervalNum: 1, limit: limits.ordersPer1d },
    { rateLimitType: 'RAW_REQUESTS', interval: 'MINUTE', intervalNum: 5, limit: limits.rawPer5Min },
  ];
}
