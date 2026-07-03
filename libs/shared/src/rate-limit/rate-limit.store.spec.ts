import { InMemoryRateLimitStore } from './rate-limit.store';

describe('InMemoryRateLimitStore', () => {
  let store: InMemoryRateLimitStore;
  afterEach(() => store?.onModuleDestroy());

  describe('weight fixed-window', () => {
    it('accumulates within the same minute window', () => {
      store = new InMemoryRateLimitStore();
      expect(store.addWeight('k', 10, 0)).toBe(10);
      expect(store.addWeight('k', 5, 1_000)).toBe(15); // same minute (floor/60000 = 0)
      expect(store.addWeight('k', 5, 59_999)).toBe(20);
    });

    it('resets when the window rolls', () => {
      store = new InMemoryRateLimitStore();
      expect(store.addWeight('k', 10, 0)).toBe(10);
      expect(store.addWeight('k', 7, 60_000)).toBe(7); // next minute
    });

    it('keys are independent', () => {
      store = new InMemoryRateLimitStore();
      expect(store.addWeight('a', 10, 0)).toBe(10);
      expect(store.addWeight('b', 3, 0)).toBe(3);
    });
  });

  describe('raw 5-minute window', () => {
    it('counts one per call and rolls every 5 minutes', () => {
      store = new InMemoryRateLimitStore();
      expect(store.addRaw('k', 0)).toBe(1);
      expect(store.addRaw('k', 299_000)).toBe(2); // same 5m bucket
      expect(store.addRaw('k', 300_000)).toBe(1); // next 5m bucket
    });
  });

  describe('order 10s + 1d counters', () => {
    it('tracks both windows and rolls the 10s independently', () => {
      store = new InMemoryRateLimitStore();
      expect(store.addOrder('u', 1, 0)).toEqual({ count10s: 1, count1d: 1 });
      expect(store.addOrder('u', 1, 5_000)).toEqual({ count10s: 2, count1d: 2 }); // same 10s
      expect(store.addOrder('u', 1, 10_000)).toEqual({ count10s: 1, count1d: 3 }); // 10s rolled, 1d not
    });
  });

  describe('LRU eviction (maxKeys bound)', () => {
    it('evicts the oldest key when the cap is reached', () => {
      store = new InMemoryRateLimitStore(2);
      store.addWeight('a', 1, 0);
      store.addWeight('b', 1, 0);
      store.addWeight('c', 1, 0); // evicts 'a'
      // 'a' was evicted → re-adding starts fresh at 1 (not 2)
      expect(store.addWeight('a', 1, 0)).toBe(1);
    });

    it('does not evict on repeated same key', () => {
      store = new InMemoryRateLimitStore(2);
      expect(store.addWeight('a', 1, 0)).toBe(1);
      expect(store.addWeight('a', 2, 0)).toBe(3);
    });
  });

  it('clear() resets all counters', () => {
    store = new InMemoryRateLimitStore();
    store.addWeight('k', 10, 0);
    store.clear();
    expect(store.addWeight('k', 1, 0)).toBe(1);
  });
});
