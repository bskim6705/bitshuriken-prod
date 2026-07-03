import { of } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitInterceptor } from './rate-limit.interceptor';
import { InMemoryRateLimitStore } from './rate-limit.store';
import { RateLimitException, TooManyOrdersException } from './rate-limit.exception';
import type { RateLimitConfig } from './rate-limit.config';
import {
  USED_WEIGHT_1M_HEADER,
  ORDER_COUNT_10S_HEADER,
  ORDER_COUNT_1D_HEADER,
  RETRY_AFTER_HEADER,
} from './rate-limit.constants';

type Meta = Record<string, unknown>;

function cfg(over: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    enabled: false,
    weightPerMin: 6000,
    rawPer5Min: 61000,
    ordersPer10s: 100,
    ordersPer1d: 200000,
    internalToken: '',
    trustProxyHops: 0,
    storeMaxKeys: 100000,
    ...over,
  };
}
function reflectorWith(meta: Meta): Reflector {
  return { getAllAndOverride: (key: string) => meta[key] } as unknown as Reflector;
}
function makeRes() {
  const headers: Record<string, string> = {};
  return { headers, setHeader: (n: string, v: string) => (headers[n] = v) };
}
function makeCtx(req: any, res: any, type: 'http' | 'ws' = 'http'): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => function handler() {},
    getClass: () => class Cls {},
  } as unknown as ExecutionContext;
}
const next: CallHandler = { handle: () => of('ok') };

describe('RateLimitInterceptor', () => {
  let store: InMemoryRateLimitStore;
  beforeEach(() => (store = new InMemoryRateLimitStore()));
  afterEach(() => store.onModuleDestroy());

  it('anonymous request buckets by ip and emits used-weight', () => {
    const ic = new RateLimitInterceptor(reflectorWith({ 'rl:weight': 5 }), store, cfg());
    const res = makeRes();
    ic.intercept(makeCtx({ ip: '1.2.3.4', headers: {} }, res), next);
    expect(res.headers[USED_WEIGHT_1M_HEADER]).toBe('5');
  });

  it('authenticated order buckets by userId (not ip) and emits order-count headers', () => {
    const ic = new RateLimitInterceptor(
      reflectorWith({ 'rl:weight': 1, 'rl:orderCount': 1 }),
      store,
      cfg(),
    );
    const r1 = makeRes();
    const r2 = makeRes();
    ic.intercept(makeCtx({ user: { userId: 'u1', email: 'e' }, ip: '1.1.1.1', headers: {} }, r1), next);
    ic.intercept(makeCtx({ user: { userId: 'u1', email: 'e' }, ip: '2.2.2.2', headers: {} }, r2), next);
    // same account bucket despite different IPs → weight accumulates to 2
    expect(r2.headers[USED_WEIGHT_1M_HEADER]).toBe('2');
    expect(r2.headers[ORDER_COUNT_10S_HEADER]).toBe('2');
    expect(r2.headers[ORDER_COUNT_1D_HEADER]).toBe('2');
  });

  it('X-Internal-Token exempts pre-auth (no headers, no reject even over limit)', () => {
    const ic = new RateLimitInterceptor(
      reflectorWith({ 'rl:weight': 9999 }),
      store,
      cfg({ enabled: true, internalToken: 'tok', weightPerMin: 1 }),
    );
    const res = makeRes();
    expect(() =>
      ic.intercept(makeCtx({ ip: '1.1.1.1', headers: { 'x-internal-token': 'tok' } }, res), next),
    ).not.toThrow();
    expect(res.headers[USED_WEIGHT_1M_HEADER]).toBeUndefined();
  });

  it('enforcement off: emits headers but never rejects, even over the limit', () => {
    const ic = new RateLimitInterceptor(
      reflectorWith({ 'rl:weight': 50 }),
      store,
      cfg({ weightPerMin: 1 }),
    );
    const res = makeRes();
    expect(() => ic.intercept(makeCtx({ ip: '1.1.1.1', headers: {} }, res), next)).not.toThrow();
    expect(res.headers[USED_WEIGHT_1M_HEADER]).toBe('50');
  });

  it('enforcement on + over weight: throws RateLimitException with Retry-After + used-weight', () => {
    const ic = new RateLimitInterceptor(
      reflectorWith({ 'rl:weight': 11 }),
      store,
      cfg({ enabled: true, weightPerMin: 10 }),
    );
    const res = makeRes();
    expect(() => ic.intercept(makeCtx({ ip: '1.1.1.1', headers: {} }, res), next)).toThrow(
      RateLimitException,
    );
    expect(res.headers[USED_WEIGHT_1M_HEADER]).toBe('11');
    expect(res.headers[RETRY_AFTER_HEADER]).toBeDefined();
  });

  it('enforcement on + too many orders: throws TooManyOrdersException', () => {
    const ic = new RateLimitInterceptor(
      reflectorWith({ 'rl:weight': 1, 'rl:orderCount': 1 }),
      store,
      cfg({ enabled: true, ordersPer10s: 2 }),
    );
    const user = { userId: 'u1', email: 'e' };
    ic.intercept(makeCtx({ user, headers: {} }, makeRes()), next); // c10=1
    ic.intercept(makeCtx({ user, headers: {} }, makeRes()), next); // c10=2
    expect(() => ic.intercept(makeCtx({ user, headers: {} }, makeRes()), next)).toThrow(
      TooManyOrdersException,
    ); // c10=3 > 2
  });

  it('non-http context passes through untouched', () => {
    const ic = new RateLimitInterceptor(
      reflectorWith({ 'rl:weight': 9999 }),
      store,
      cfg({ enabled: true, weightPerMin: 1 }),
    );
    const res = makeRes();
    expect(() =>
      ic.intercept(makeCtx({ ip: '1.1.1.1', headers: {} }, res, 'ws'), next),
    ).not.toThrow();
    expect(res.headers[USED_WEIGHT_1M_HEADER]).toBeUndefined();
  });
});
