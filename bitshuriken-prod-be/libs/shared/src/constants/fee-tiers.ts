import { MarketType } from '@prisma/client';

export interface FeeTierRates {
  makerBps: number;
  takerBps: number;
}

/**
 * 수수료 티어 테이블 — admin이 유저별 tier를 수동 지정 (볼륨 자동 산정 없음).
 * maker 하한 0bps, 리베이트(음수) 없음. T0는 종전 플랫 10/10과 동일 — 기본 동작 불변.
 */
export const FEE_TIERS: ReadonlyArray<{ spot: FeeTierRates; futures: FeeTierRates }> = [
  { spot: { makerBps: 10, takerBps: 10 }, futures: { makerBps: 10, takerBps: 10 } },
  { spot: { makerBps: 8, takerBps: 9 }, futures: { makerBps: 5, takerBps: 7 } },
  { spot: { makerBps: 6, takerBps: 8 }, futures: { makerBps: 3, takerBps: 5 } },
  { spot: { makerBps: 4, takerBps: 6 }, futures: { makerBps: 2, takerBps: 4 } },
  { spot: { makerBps: 2, takerBps: 4 }, futures: { makerBps: 1, takerBps: 3 } },
  { spot: { makerBps: 0, takerBps: 3 }, futures: { makerBps: 0, takerBps: 2 } },
];

export const MAX_FEE_TIER = FEE_TIERS.length - 1;

/** tier×마켓 요율. 범위 밖 tier는 throw — 기본값 대체 금지. */
export function feeTierRates(tier: number, market: MarketType): FeeTierRates {
  const row = Number.isInteger(tier) && tier >= 0 ? FEE_TIERS[tier] : undefined;
  if (!row) throw new Error(`unknown fee tier ${tier} (valid: 0..${MAX_FEE_TIER})`);
  return market === MarketType.FUTURES ? row.futures : row.spot;
}
