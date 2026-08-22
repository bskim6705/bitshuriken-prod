import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';
import { atr } from '../indicators/atr';
import { klines } from '../core/exchange';

const WARMUP = 60; // seed ATR + lead-return buffer before the first signal
const STALE_MS = 10 * 60_000; // a BTC bar this far off the sim/live clock ⇒ not a synchronized live feed

interface P {
  leadBars: number; // lookback for BTC's (or the proxy's) leg down
  btcThreshPct: number; // trigger when BTC return over leadBars < −this (percent, 0.5 = 0.5%)
  k: number; // LIMIT bid depth below current, in units of ATR% (fraction of price)
  m: number; // take-profit above the fill, in units of ATR%
  atrLen: number; // bars of 1m ATR for the volatility scale
  entryFrac: number; // equity fraction sized into the bid
}

/**
 * BTC-leads-alts overshoot catcher (spot, long-only). Each bar, while unarmed, it reads BTC's
 * recent 1m return from OUR exchange REST (same-origin klines) and — when BTC has legged down more
 * than btcThreshPct over leadBars — rests a single LIMIT bid on this agent's alt k×ATR% below the
 * current price, betting the alt overshoots BTC's move with lag; a fill arms a TP LIMIT m×ATR% up.
 * One armed bid at a time; a completed round trip (TP fill) re-arms. LIMIT in / LIMIT out.
 *
 * BACKTEST CAVEAT (smoke test only): SimBroker replays this alt's history with no synchronized BTC
 * feed — the local REST returns LIVE bars whose close-time won't match the simulated bar clock.
 * onBar detects that mismatch (or a fetch failure) and FALLS BACK to a proxy trigger: the alt's OWN
 * return over leadBars. So in backtest leadlag is merely a self-momentum dip-catcher and the numbers
 * only exercise the plumbing / exit geometry — the real BTC-lead signal is LIVE-ONLY. btcFeed=off
 * forces the proxy; the default 'auto' latches to the proxy once staleness proves it's a backtest.
 *
 * No-cancel note (framework-wide): an unfilled bid physically rests until price reaches it; re-arm
 * happens only after a full round trip. Once filled the position holds to its TP (no stop), same as
 * the dip-ladder family.
 */
class LeadLag implements Strategy {
  readonly id = 'leadlag';
  readonly warmupBars = WARMUP;
  private ctx!: ExecutionContext;
  private p: P = { leadBars: 5, btcThreshPct: 0.5, k: 1.2, m: 1.8, atrLen: 30, entryFrac: 0.5 };
  private btcFeed = 'auto'; // 'auto' | 'on' | 'off'
  private bars: Bar[] = []; // rolling buffer for ATR + the proxy return
  private armed = false; // a bid (or its resulting TP) is live — one at a time
  private armAtrPct = 0; // ATR% frozen at arm time so the TP matches the entry's vol snapshot
  private proxyLatched = false; // set once a stale BTC feed proves we're in backtest

  init(ctx: ExecutionContext, params: StrategyParams): void {
    this.ctx = ctx;
    this.applyParams(params);
  }

  applyParams(params: StrategyParams): void {
    for (const key of Object.keys(this.p) as (keyof P)[]) {
      const v = params[key];
      if (typeof v === 'number') this.p[key] = v;
    }
    const bf = params.btcFeed;
    if (typeof bf === 'string') this.btcFeed = bf;
  }

  private bufLen(): number {
    return Math.max(this.p.atrLen, this.p.leadBars) + 1;
  }

  warmup(bars: Bar[]): void {
    this.bars = bars.slice(-this.bufLen());
  }

  private pushBar(b: Bar): void {
    this.bars.push(b);
    while (this.bars.length > this.bufLen()) this.bars.shift();
  }

  /** alt's own return over leadBars (the backtest proxy trigger), or null if history is short. */
  private altReturn(): number | null {
    const n = this.bars.length;
    if (n < this.p.leadBars + 1) return null;
    const c0 = this.bars[n - 1 - this.p.leadBars]!.close;
    const c1 = this.bars[n - 1]!.close;
    return c0 > 0 ? (c1 - c0) / c0 : null;
  }

  private proxyTriggered(thresh: number): boolean {
    const r = this.altReturn();
    return r !== null && r < -thresh;
  }

  /** True when BTC (live feed) — or the alt itself (proxy/backtest) — has legged down past threshold. */
  private async triggered(): Promise<boolean> {
    const thresh = this.p.btcThreshPct / 100;
    if (this.btcFeed === 'off' || this.proxyLatched) return this.proxyTriggered(thresh);
    try {
      const btc = await klines('SPOT', 'BTCUSDT', '1m', this.p.leadBars + 1);
      const newest = btc[btc.length - 1];
      if (!newest) return this.proxyTriggered(thresh);
      if (this.btcFeed !== 'on' && Math.abs(newest.closeTime - this.ctx.now()) > STALE_MS) {
        this.proxyLatched = true; // clock mismatch ⇒ backtest: use the proxy for the rest of the run
        return this.proxyTriggered(thresh);
      }
      if (btc.length < this.p.leadBars + 1) return false;
      const c0 = btc[btc.length - 1 - this.p.leadBars]!.close;
      if (!(c0 > 0)) return false;
      return (newest.close - c0) / c0 < -thresh;
    } catch {
      return this.proxyTriggered(thresh); // exchange down / transient / no env — proxy this bar, don't latch
    }
  }

  async onBar(bar: Bar): Promise<void> {
    this.pushBar(bar);
    if (this.armed) return;
    const ref = bar.close;
    if (ref <= 0) return;
    const atrPct = atr(this.bars, this.p.atrLen) / ref;
    if (!(atrPct > 0)) return;
    if (!(await this.triggered())) return;
    const price = ref * (1 - this.p.k * atrPct);
    if (price <= 0) return;
    const qty = fixedFractionQty(this.ctx, price, this.p.entryFrac);
    if (qty <= 0) return;
    const pos = this.ctx.position();
    const quoteLeft = Math.max(this.ctx.equityUsdt() - pos.qty * ref, 0);
    if (price * qty > quoteLeft) return;
    void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price, qty });
    this.armed = true;
    this.armAtrPct = atrPct;
  }

  onFill(f: Fill): void {
    if (!this.armed) return;
    // BUY (overshoot caught) -> take-profit SELL m×ATR% up; TP SELL -> resolved, free to re-arm.
    if (f.side === 'BUY') {
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price * (1 + this.p.m * this.armAtrPct), qty: f.qty });
    } else {
      this.armed = false;
    }
  }
}

const factory: StrategyFactory = {
  id: 'leadlag',
  paramSchema: {
    leadBars: { type: 'number', default: 5, min: 1, max: 60, desc: 'lookback bars for the BTC (or proxy) leg down' },
    btcThreshPct: { type: 'number', default: 0.5, min: 0.05, max: 10, desc: 'trigger when BTC return over leadBars < −this (percent)' },
    k: { type: 'number', default: 1.2, min: 0.1, max: 8, desc: 'LIMIT bid depth below current, in ATR% units' },
    m: { type: 'number', default: 1.8, min: 0.2, max: 10, desc: 'take-profit above the fill, in ATR% units' },
    atrLen: { type: 'number', default: 30, min: 5, max: 50, desc: 'bars of 1m ATR for the volatility scale' },
    entryFrac: { type: 'number', default: 0.5, min: 0.01, max: 1, desc: 'equity fraction sized into the bid' },
    btcFeed: { type: 'string', default: 'auto', desc: "'auto' (proxy when BTC feed is stale/backtest), 'on' (force live BTC), 'off' (force alt-momentum proxy)" },
  },
  create: () => new LeadLag(),
};

export default factory;
