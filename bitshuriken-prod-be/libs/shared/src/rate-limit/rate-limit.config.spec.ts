import { loadRateLimitRuntime, resolveRateLimitConfig, buildRateLimits } from './rate-limit.config';
import { limitsForApp } from './rate-limit.defaults';

describe('loadRateLimitRuntime (env-only values)', () => {
  it('uses safe defaults (enforcement off) when env is empty', () => {
    const r = loadRateLimitRuntime({});
    expect(r.enabled).toBe(false);
    expect(r.internalToken).toBe('');
    expect(r.trustProxyHops).toBe(0);
    expect(r.storeMaxKeys).toBe(100000);
  });

  it('parses toggle, secret and proxy hops', () => {
    const r = loadRateLimitRuntime({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_INTERNAL_TOKEN: 'sekret',
      RATE_LIMIT_TRUST_PROXY_HOPS: '1',
    });
    expect(r.enabled).toBe(true);
    expect(r.internalToken).toBe('sekret');
    expect(r.trustProxyHops).toBe(1);
  });
});

describe('limitsForApp (code constants, not env)', () => {
  it('futures keeps its own fapi pool (2400 weight / 300 orders)', () => {
    expect(limitsForApp('spot').weightPerMin).toBe(6000);
    expect(limitsForApp('futures').weightPerMin).toBe(2400);
    expect(limitsForApp('futures').ordersPer10s).toBe(300);
    expect(limitsForApp('portal').weightPerMin).toBe(6000);
  });
});

describe('resolveRateLimitConfig', () => {
  it('merges per-app code limits with env runtime', () => {
    const c = resolveRateLimitConfig('futures', { RATE_LIMIT_ENABLED: 'true' });
    expect(c.weightPerMin).toBe(2400); // from code
    expect(c.enabled).toBe(true); // from env
  });
});

describe('buildRateLimits', () => {
  it('emits Binance-shaped rows from the per-app limits', () => {
    const rows = buildRateLimits(limitsForApp('futures'));
    expect(rows).toContainEqual({
      rateLimitType: 'REQUEST_WEIGHT',
      interval: 'MINUTE',
      intervalNum: 1,
      limit: 2400,
    });
    expect(rows.filter((r) => r.rateLimitType === 'ORDERS')).toHaveLength(2);
    expect(rows).toContainEqual({
      rateLimitType: 'RAW_REQUESTS',
      interval: 'MINUTE',
      intervalNum: 5,
      limit: 61000,
    });
  });
});
