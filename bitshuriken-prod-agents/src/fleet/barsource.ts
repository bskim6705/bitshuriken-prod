import { klines } from '../core/exchange';
import { makeLogger, type Logger } from '../core/logger';
import type { Bar, Market } from '../core/types';

type BarCb = (bar: Bar) => void;

/**
 * Polls the local exchange's klines for one (market, symbol, interval) and emits each
 * newly-FINAL bar to subscribers. One clock is shared by all agents on that stream.
 */
export class BarClock {
  private readonly subs = new Set<BarCb>();
  private timer: NodeJS.Timeout | null = null;
  private lastEmitted = 0;
  private seeded = false; // first poll only records the latest bar, doesn't replay history
  private polling = false;
  private readonly log: Logger;

  constructor(
    readonly market: Market,
    readonly symbol: string,
    readonly interval: string,
    private readonly pollMs: number,
  ) {
    this.log = makeLogger(`bars:${symbol}:${interval}`);
  }

  onBar(cb: BarCb): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  get subscriberCount(): number {
    return this.subs.size;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // a slow poll must not overlap the next tick
    this.polling = true;
    try {
      const finals = (await klines(this.market, this.symbol, this.interval, 3)).filter((b) => b.isFinal);
      if (!this.seeded) {
        // agents warm up from history themselves; only emit bars that close AFTER start
        for (const b of finals) this.lastEmitted = Math.max(this.lastEmitted, b.openTime);
        this.seeded = true;
        return;
      }
      for (const b of finals) {
        if (b.openTime > this.lastEmitted) {
          this.lastEmitted = b.openTime;
          for (const cb of this.subs) cb(b);
        }
      }
    } catch (e) {
      this.log.warn('poll failed', (e as Error).message);
    } finally {
      this.polling = false;
    }
  }
}
