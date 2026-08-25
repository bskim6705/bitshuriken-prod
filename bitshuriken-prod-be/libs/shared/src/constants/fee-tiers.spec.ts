import { MarketType } from '@prisma/client';
import { FEE_TIERS, MAX_FEE_TIER, feeTierRates } from './fee-tiers';

describe('feeTierRates', () => {
  it('T0 = 종전 플랫 10/10 (스팟·선물 동일) — 기본 동작 불변', () => {
    expect(feeTierRates(0, MarketType.SPOT)).toEqual({ makerBps: 10, takerBps: 10 });
    expect(feeTierRates(0, MarketType.FUTURES)).toEqual({ makerBps: 10, takerBps: 10 });
  });

  it('마켓별로 다른 요율을 반환한다', () => {
    const spot = feeTierRates(2, MarketType.SPOT);
    const fut = feeTierRates(2, MarketType.FUTURES);
    expect(spot).toEqual({ makerBps: 6, takerBps: 8 });
    expect(fut).toEqual({ makerBps: 3, takerBps: 5 });
  });

  it('모든 티어는 maker ≥ 0 (리베이트 없음) · 상위 티어로 갈수록 단조 하강', () => {
    for (const market of ['spot', 'futures'] as const) {
      for (let t = 0; t <= MAX_FEE_TIER; t++) {
        expect(FEE_TIERS[t][market].makerBps).toBeGreaterThanOrEqual(0);
        expect(FEE_TIERS[t][market].takerBps).toBeGreaterThanOrEqual(0);
        if (t > 0) {
          expect(FEE_TIERS[t][market].makerBps).toBeLessThanOrEqual(FEE_TIERS[t - 1][market].makerBps);
          expect(FEE_TIERS[t][market].takerBps).toBeLessThanOrEqual(FEE_TIERS[t - 1][market].takerBps);
        }
      }
    }
  });

  it('범위 밖·비정수 tier는 throw — 기본값 대체 금지', () => {
    expect(() => feeTierRates(MAX_FEE_TIER + 1, MarketType.SPOT)).toThrow(/unknown fee tier/);
    expect(() => feeTierRates(-1, MarketType.SPOT)).toThrow(/unknown fee tier/);
    expect(() => feeTierRates(1.5, MarketType.SPOT)).toThrow(/unknown fee tier/);
  });
});
