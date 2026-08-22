import { TtlLruCache } from './ttl-lru-cache';

describe('TtlLruCache', () => {
  it('returns stored value before TTL and undefined after expiry', () => {
    const c = new TtlLruCache<number>(100, 10);
    c.set('a', 1, 1000);
    expect(c.get('a', 1099)).toBe(1); // 99ms < 100ms TTL
    expect(c.get('a', 1100)).toBeUndefined(); // expiresAt(1100) <= now → expired
  });

  it('lazy-deletes expired entries on get', () => {
    const c = new TtlLruCache<number>(100, 10);
    c.set('a', 1, 1000);
    c.get('a', 2000); // expired → deleted
    expect(c.size).toBe(0);
  });

  it('evicts the oldest key when over capacity', () => {
    const c = new TtlLruCache<number>(10_000, 2);
    c.set('a', 1, 0);
    c.set('b', 2, 0);
    c.set('c', 3, 0); // over cap → evict 'a'
    expect(c.get('a', 0)).toBeUndefined();
    expect(c.get('b', 0)).toBe(2);
    expect(c.get('c', 0)).toBe(3);
  });

  it('treats a get hit as most-recently-used (LRU order)', () => {
    const c = new TtlLruCache<number>(10_000, 2);
    c.set('a', 1, 0);
    c.set('b', 2, 0);
    c.get('a', 0); // 'a' refreshed → 'b' now oldest
    c.set('c', 3, 0); // evict 'b'
    expect(c.get('a', 0)).toBe(1);
    expect(c.get('b', 0)).toBeUndefined();
  });

  it('delete and clear remove entries', () => {
    const c = new TtlLruCache<number>(10_000, 10);
    c.set('a', 1, 0);
    c.set('b', 2, 0);
    c.delete('a');
    expect(c.get('a', 0)).toBeUndefined();
    c.clear();
    expect(c.size).toBe(0);
  });
});
