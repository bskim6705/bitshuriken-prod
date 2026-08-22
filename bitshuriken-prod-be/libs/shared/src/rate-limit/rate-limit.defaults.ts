/**
 * 앱(=Binance base endpoint)별 weight/order 한도 — 정책 상수. 배포마다 바뀌지 않으므로 코드에 둔다
 * (.env 아님; feedback-020). 앱별 독립 풀 = Binance가 spot/fapi weight 풀을 분리 운영하는 것과 일치.
 */
export type RateLimitApp = 'spot' | 'futures' | 'portal';

export interface RateLimitLimits {
  weightPerMin: number;
  rawPer5Min: number;
  ordersPer10s: number;
  ordersPer1d: number;
}

const DEFAULT_LIMITS: RateLimitLimits = {
  weightPerMin: 6000,
  rawPer5Min: 61000,
  ordersPer10s: 100,
  ordersPer1d: 200000,
};

/** Binance 미러 기본값. futures(fapi)만 별도. */
export const RATE_LIMIT_LIMITS: Record<RateLimitApp, RateLimitLimits> = {
  spot: { ...DEFAULT_LIMITS },
  futures: { weightPerMin: 2400, rawPer5Min: 61000, ordersPer10s: 300, ordersPer1d: 200000 },
  portal: { ...DEFAULT_LIMITS },
};

export function limitsForApp(app: RateLimitApp): RateLimitLimits {
  return RATE_LIMIT_LIMITS[app];
}
