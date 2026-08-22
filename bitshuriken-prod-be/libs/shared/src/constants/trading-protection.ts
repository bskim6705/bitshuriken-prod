/**
 * 시장 보호장치 정책 상수 — 배포마다 바뀌지 않으므로 코드에 둔다(.env 아님; feedback-020).
 * futures 가격 밴드는 심볼별 FuturesConfig.priceBandPct로 별도 관리(여기 상수 아님).
 */

/** spot LIMIT 호가 허용폭. 기준가(5m 가중평균 or last) ±10% 밖이면 거부(PERCENT_PRICE 대응). */
export const SPOT_PRICE_BAND_PCT = '0.1';

/** 유저·심볼당 오픈 주문(NEW/OPEN/PARTIAL) 상한. OCO는 2건으로 계산. 청산 주문은 면제. */
export const MAX_OPEN_ORDERS_PER_SYMBOL = 200;

/**
 * 시장조성 계정(User.rateLimitExempt) 전용 오픈 주문 상한 (ADR-068).
 * 미러 봇의 50레벨×양사이드(정상 ~100) + 재시작·고변동 churn의 in-flight 겹침 여유.
 */
export const MM_MAX_OPEN_ORDERS_PER_SYMBOL = 2000;
