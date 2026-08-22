/**
 * 단일 프로세스 인메모리 TTL + LRU 캐시. 인증 핫패스(요청당 pg 왕복 제거)용.
 * 만료는 get 시점 lazy 제거, 상한 초과 시 삽입/사용 순 가장 오래된 키부터 evict.
 * Map의 삽입 순서를 LRU 큐로 사용 (get 히트 시 delete→set으로 최신화).
 */
export class TtlLruCache<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxKeys: number,
  ) {}

  get(key: string, now: number = Date.now()): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    // LRU 최신화
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: V, now: number = Date.now()): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.map.size > this.maxKeys) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
