import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';

const WARMUP = 30; // bars pre-loaded to seed the volume baseline
const PENDING_TIMEOUT = 4; // bars to wait on an unfilled entry / stuck exit before abandoning-or-retrying

interface P {
  window: number; // bars of history for the rolling volume baseline
  volMult: number; // a bar counts as a surge only if its volume ≥ volMult × the baseline
  bodyPct: number; // …and it closes ≤ -bodyPct (a red flush) near its low, to fade
  tpPct: number; // take-profit above entry (fraction)
  slPct: number; // stop-loss below entry (fraction)
  maxBars: number; // time-stop: flatten after this many held bars if neither TP nor SL hit
  entryFrac: number; // equity fraction spent per entry (quote)
}

/**
 * Volume-surge fade (spot, long-only, contrarian). Watches for a *capitulation* bar — one
 * whose volume spikes above volMult × its recent average AND that closes sharply red
 * (≤ -bodyPct) in the lower half of its range. Such flushes on 1m crypto are usually
 * liquidity-vacuum overshoots that snap back a bar or two later, so we BUY the panic (taker,
 * for immediacy) and bracket it: flatten on the first bar that trades through TP, through SL,
 * or after maxBars. One position at a time (flat→long→flat), driven by onBar (detect + bracket)
 * off the broker's own position()/avgEntry, so it survives restarts and delayed fills. Exits
 * are MARKET by design: this framework can't cancel a resting order, so an OCO of resting-TP +
 * market-stop would risk a stale naked short — a single market exit is race-free. TP/SL sit
 * well above the 20bps round-trip taker cost.
 */
class SurgeFade implements Strategy {
  readonly id = 'surgefade';
  readonly warmupBars = WARMUP;
  private ctx!: ExecutionContext;
  private p: P = { window: 20, volMult: 1.8, bodyPct: 0.003, tpPct: 0.006, slPct: 0.006, maxBars: 8, entryFrac: 0.5 };
  private vols: number[] = []; // rolling recent volumes (length ≤ window)
  private barsHeld = 0; // bars since the current long was opened
  private entrySubmitted = false; // an entry BUY is in flight (awaiting position to reflect it)
  private exitSubmitted = false; // a FLATTEN is in flight
  private entryBars = 0; // bars an unfilled entry has been pending
  private exitBars = 0; // bars a submitted exit has been pending

  init(ctx: ExecutionContext, params: StrategyParams): void {
    this.ctx = ctx;
    this.applyParams(params);
  }

  applyParams(params: StrategyParams): void {
    for (const k of Object.keys(this.p) as (keyof P)[]) {
      const v = params[k];
      if (typeof v === 'number') this.p[k] = v;
    }
  }

  warmup(bars: Bar[]): void {
    for (const b of bars) this.pushVol(b.volume);
  }

  private pushVol(v: number): void {
    this.vols.push(v);
    while (this.vols.length > this.p.window) this.vols.shift();
  }

  onBar(bar: Bar): void {
    const pos = this.ctx.position();
    const isLong = pos.qty * bar.close >= this.ctx.spec.minNotional; // dust below min-notional counts as flat

    if (isLong) {
      this.entrySubmitted = false;
      this.barsHeld++;
      if (!this.exitSubmitted) {
        const tp = pos.avgEntry * (1 + this.p.tpPct);
        const sl = pos.avgEntry * (1 - this.p.slPct);
        if (bar.high >= tp || bar.low <= sl || this.barsHeld >= this.p.maxBars) {
          void this.ctx.submit({ kind: 'FLATTEN' });
          this.exitSubmitted = true;
          this.exitBars = 0;
        }
      } else if (++this.exitBars > PENDING_TIMEOUT) {
        void this.ctx.submit({ kind: 'FLATTEN' }); // exit didn't take — retry
        this.exitBars = 0;
      }
    } else {
      this.barsHeld = 0;
      this.exitSubmitted = false;
      if (!this.entrySubmitted) {
        if (this.isSurgeFlush(bar)) this.enter(bar);
      } else if (++this.entryBars > PENDING_TIMEOUT) {
        this.entrySubmitted = false; // entry never filled (thin book) — drop this signal
      }
    }

    this.pushVol(bar.volume); // baseline excludes the current bar (pushed after the check)
  }

  private isSurgeFlush(bar: Bar): boolean {
    if (this.vols.length === 0) return false;
    const avgVol = this.vols.reduce((a, b) => a + b, 0) / this.vols.length;
    if (avgVol <= 0 || bar.volume < this.p.volMult * avgVol) return false;
    const ret = bar.open > 0 ? (bar.close - bar.open) / bar.open : 0;
    const range = bar.high - bar.low;
    const closeLoc = range > 0 ? (bar.close - bar.low) / range : 1; // 0 = closed on the low
    return ret <= -this.p.bodyPct && closeLoc <= 0.5;
  }

  private enter(_bar: Bar): void {
    const quoteQty = this.ctx.equityUsdt() * Math.min(this.p.entryFrac, 1);
    if (quoteQty < this.ctx.spec.minNotional) return;
    void this.ctx.submit({ kind: 'MARKET_QUOTE', side: 'BUY', quoteQty });
    this.entrySubmitted = true;
    this.entryBars = 0;
  }

  onFill(f: Fill): void {
    // Bookkeeping only — onBar decides off position()/avgEntry. Logs so fills are visible in metrics.
    this.ctx.log.info(`surgefade fill ${f.side} ${f.qty}@${f.price} ${f.isMaker ? 'maker' : 'taker'}`);
  }
}

const factory: StrategyFactory = {
  id: 'surgefade',
  paramSchema: {
    window: { type: 'number', default: 20, min: 5, max: 100, desc: 'bars in the rolling volume baseline' },
    volMult: { type: 'number', default: 1.8, min: 1.1, max: 10, desc: 'surge threshold as a multiple of avg volume' },
    bodyPct: { type: 'number', default: 0.003, min: 0.0005, max: 0.05, desc: 'min red-body size to fade (fraction)' },
    tpPct: { type: 'number', default: 0.006, min: 0.001, max: 0.1, desc: 'take-profit above entry (fraction)' },
    slPct: { type: 'number', default: 0.006, min: 0.001, max: 0.1, desc: 'stop-loss below entry (fraction)' },
    maxBars: { type: 'number', default: 8, min: 1, max: 60, desc: 'time-stop in held bars' },
    entryFrac: { type: 'number', default: 0.5, min: 0.01, max: 1, desc: 'equity fraction per entry (quote)' },
  },
  create: () => new SurgeFade(),
};

export default factory;
