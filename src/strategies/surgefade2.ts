import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';

const WARMUP = 30; // seed the volume baseline before the first signal

interface P {
  window: number; // bars in the rolling volume MA
  volMult: number; // surge = volume > volMult × the MA
  bodyPct: number; // …on a red body ≥ this fraction (open→close)
  tpPct: number; // take-profit above the fill (fraction)
  armBars: number; // give up an unfilled bid after this many bars
  entryFrac: number; // equity fraction sized into the bid
}

/**
 * Corrected volume-surge fade (spot, long-only, contrarian). A capitulation bar (volume >
 * volMult × its window MA AND a red body ≥ bodyPct) is only ACTED ON after ONE stabilization bar
 * whose low holds at/above the surge bar's low — confirming the flush didn't extend. It then rests
 * a LIMIT bid AT the surge bar's low (maker, not a market chase), so we enter only if price retests
 * the flush wick; a fill arms a TP LIMIT tpPct up. An unfilled bid is abandoned after armBars and
 * the next signal re-anchors a fresh bid. This fixes the original surgefade, which market-bought the
 * panic close (paying taker + the worst price). onFill-driven TP.
 *
 * No-cancel note (framework-wide): a resting LIMIT can't be cancelled, so "give up" only stops us
 * WAITING — an abandoned bid physically rests and, if price later revisits the wick, still fills and
 * is TP'd (position-consistent, bounded by entryFrac). Once filled the position holds to its TP
 * (no stop), same as the dip-ladder family.
 */
class SurgeFade2 implements Strategy {
  readonly id = 'surgefade2';
  readonly warmupBars = WARMUP;
  private ctx!: ExecutionContext;
  private p: P = { window: 20, volMult: 1.5, bodyPct: 0.002, tpPct: 0.008, armBars: 15, entryFrac: 0.5 };
  private vols: number[] = []; // rolling recent volumes (length ≤ window)
  private armed = false; // a fresh-signal bid is pending a fill (blocks new signals)
  private armWaited = 0; // bars the pending bid has gone unfilled
  private pendingLow: number | null = null; // surge bar's low, awaiting one stabilization bar

  init(ctx: ExecutionContext, params: StrategyParams): void {
    this.ctx = ctx;
    this.applyParams(params);
  }

  applyParams(params: StrategyParams): void {
    for (const key of Object.keys(this.p) as (keyof P)[]) {
      const v = params[key];
      if (typeof v === 'number') this.p[key] = v;
    }
  }

  warmup(bars: Bar[]): void {
    for (const b of bars) this.pushVol(b.volume);
  }

  private pushVol(v: number): void {
    this.vols.push(v);
    while (this.vols.length > this.p.window) this.vols.shift();
  }

  private isSurge(bar: Bar): boolean {
    if (this.vols.length === 0) return false;
    const avg = this.vols.reduce((a, b) => a + b, 0) / this.vols.length;
    if (avg <= 0 || bar.volume < this.p.volMult * avg) return false;
    const body = bar.open > 0 ? (bar.open - bar.close) / bar.open : 0;
    return body >= this.p.bodyPct; // red body of at least bodyPct
  }

  onBar(bar: Bar): void {
    const pos = this.ctx.position();
    const isLong = pos.qty * bar.close >= this.ctx.spec.minNotional; // dust below min-notional counts as flat

    if (isLong) {
      // In a trade: the TP was armed onFill; just wait for it. Reset the hunt state.
      this.armed = false;
      this.armWaited = 0;
      this.pendingLow = null;
    } else if (this.armed) {
      // Bid resting unfilled — give up after armBars (it physically rests; see no-cancel note).
      if (++this.armWaited >= this.p.armBars) {
        this.armed = false;
        this.armWaited = 0;
      }
    } else if (this.pendingLow !== null) {
      // The stabilization bar: if the flush held, bid at the surge low; else invalidate.
      if (bar.low >= this.pendingLow) {
        const price = this.pendingLow;
        const qty = fixedFractionQty(this.ctx, price, this.p.entryFrac);
        if (qty > 0) {
          void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price, qty });
          this.armed = true;
          this.armWaited = 0;
        }
        this.pendingLow = null;
      } else {
        this.pendingLow = this.isSurge(bar) ? bar.low : null; // flush extended → this bar may be a new surge
      }
    } else if (this.isSurge(bar)) {
      this.pendingLow = bar.low; // await one stabilization bar before bidding
    }

    this.pushVol(bar.volume); // baseline excludes the current bar (pushed after the check)
  }

  onFill(f: Fill): void {
    // Each BUY fill arms its own TP SELL; the round trip completes when that TP fills (onBar sees flat).
    if (f.side === 'BUY') {
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price * (1 + this.p.tpPct), qty: f.qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'surgefade2',
  paramSchema: {
    window: { type: 'number', default: 20, min: 5, max: 100, desc: 'bars in the rolling volume MA' },
    volMult: { type: 'number', default: 1.5, min: 1.1, max: 10, desc: 'surge threshold as a multiple of the volume MA' },
    bodyPct: { type: 'number', default: 0.002, min: 0.0005, max: 0.05, desc: 'min red-body size to fade (fraction)' },
    tpPct: { type: 'number', default: 0.008, min: 0.001, max: 0.1, desc: 'take-profit above the fill (fraction)' },
    armBars: { type: 'number', default: 15, min: 1, max: 120, desc: 'give up an unfilled bid after this many bars' },
    entryFrac: { type: 'number', default: 0.5, min: 0.01, max: 1, desc: 'equity fraction sized into the bid' },
  },
  create: () => new SurgeFade2(),
};

export default factory;
