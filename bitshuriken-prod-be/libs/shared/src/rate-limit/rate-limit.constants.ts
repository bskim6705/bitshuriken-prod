/** Binance 스타일 rate-limit 응답 헤더 + 메타데이터/DI 키. */

export const USED_WEIGHT_1M_HEADER = 'X-MBX-USED-WEIGHT-1M';
export const ORDER_COUNT_10S_HEADER = 'X-MBX-ORDER-COUNT-10S';
export const ORDER_COUNT_1D_HEADER = 'X-MBX-ORDER-COUNT-1D';
export const RETRY_AFTER_HEADER = 'Retry-After';

/** cross-origin FE가 읽을 수 있도록 CORS로 노출해야 하는 헤더 (없으면 브라우저가 null). */
export const RATE_LIMIT_EXPOSED_HEADERS = [
  RETRY_AFTER_HEADER,
  USED_WEIGHT_1M_HEADER,
  ORDER_COUNT_10S_HEADER,
  ORDER_COUNT_1D_HEADER,
] as const;

/** @Weight / @OrderCount 메타데이터 키. */
export const WEIGHT_METADATA = 'rl:weight';
export const ORDER_COUNT_METADATA = 'rl:orderCount';

/** RateLimitConfig DI 토큰. */
export const RATE_LIMIT_CONFIG = 'RATE_LIMIT_CONFIG';
