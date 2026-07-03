import { Injectable, OnModuleDestroy } from '@nestjs/common';

export interface OrderTally {
  count10s: number;
  count1d: number;
}

/**
 * Rate-limit 카운터 저장소. 기본 구현은 단일 프로세스 인메모리(앱별 독립).
 * 스케일아웃(앱당 replica >1) 시 이 인터페이스를 공유 저장소(Redis/Postgres)로 교체한다.
 */
export abstract class RateLimitStore {
  /** weight를 더하고 현재 분 윈도우 누적값을 반환. */
  abstract addWeight(key: string, weight: number, now: number): number;
  /** raw 요청 수를 더하고 현재 5분 윈도우 누적값을 반환. */
  abstract addRaw(key: string, now: number): number;
  /** 주문 수를 더하고 10s/1d 윈도우 누적값을 반환. */
  abstract addOrder(key: string, n: number, now: number): OrderTally;
}

const MINUTE = 60_000;
const FIVE_MIN = 300_000;
const TEN_SEC = 10_000;
const DAY = 86_400_000;

interface Window {
  id: number;
  n: number;
}
interface OrderEntry {
  w10: number;
  c10: number;
  w1d: number;
  c1d: number;
}

@Injectable()
export class InMemoryRateLimitStore extends RateLimitStore implements OnModuleDestroy {
  private weight = new Map<string, Window>();
  private raw = new Map<string, Window>();
  private orders = new Map<string, OrderEntry>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(private readonly maxKeys = 100_000) {
    super();
    this.sweepTimer = setInterval(() => this.sweep(), MINUTE);
    // 타이머가 프로세스를 살려두지 않게 (테스트/종료 시 hang 방지).
    this.sweepTimer.unref?.();
  }

  addWeight(key: string, weight: number, now: number): number {
    return this.bump(this.weight, key, Math.floor(now / MINUTE), weight);
  }

  addRaw(key: string, now: number): number {
    return this.bump(this.raw, key, Math.floor(now / FIVE_MIN), 1);
  }

  addOrder(key: string, n: number, now: number): OrderTally {
    const w10 = Math.floor(now / TEN_SEC);
    const w1d = Math.floor(now / DAY);
    let e = this.orders.get(key);
    if (!e) {
      this.evict(this.orders);
      e = { w10, c10: 0, w1d, c1d: 0 };
      this.orders.set(key, e);
    }
    if (e.w10 !== w10) {
      e.w10 = w10;
      e.c10 = 0;
    }
    if (e.w1d !== w1d) {
      e.w1d = w1d;
      e.c1d = 0;
    }
    e.c10 += n;
    e.c1d += n;
    return { count10s: e.c10, count1d: e.c1d };
  }

  private bump(map: Map<string, Window>, key: string, windowId: number, add: number): number {
    let e = map.get(key);
    if (!e || e.id !== windowId) {
      if (!e) this.evict(map);
      e = { id: windowId, n: 0 };
      map.set(key, e);
    }
    e.n += add;
    return e.n;
  }

  /** maxKeys 도달 시 삽입순 가장 오래된 키부터 제거 — 다수 distinct IP 폭주로 인한 OOM 방지. */
  private evict(map: Map<string, unknown>): void {
    while (map.size >= this.maxKeys) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /** 만료 윈도우 엔트리 정리. */
  private sweep(): void {
    const now = Date.now();
    const wMin = Math.floor(now / MINUTE);
    const wRaw = Math.floor(now / FIVE_MIN);
    const w1d = Math.floor(now / DAY);
    for (const [k, e] of this.weight) if (e.id < wMin) this.weight.delete(k);
    for (const [k, e] of this.raw) if (e.id < wRaw) this.raw.delete(k);
    for (const [k, e] of this.orders) if (e.w1d < w1d) this.orders.delete(k);
  }

  /** 테스트/디버그용 전체 초기화. */
  clear(): void {
    this.weight.clear();
    this.raw.clear();
    this.orders.clear();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }
}
