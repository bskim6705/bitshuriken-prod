import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';

const DEFAULT_RUNGS = [0.006, 0.012, 0.02, 0.03]; // shallow dips for chop, not deep crashes

interface P {
  rungPcts: number[]; // dip depths below mid, as fractions
  tpPct: number; // take-profit above each entry (0.005 = 0.5%)
  rungFrac: number; // equity fraction per rung
}

/** parse a comma-separated depth list ("0.006,0.012,...") or a single number; fall back to defaults. */
function parseRungs(v: unknown): number[] {
  if (typeof v === 'number' && v > 0) return [v];
  if (typeof v === 'string') {
    const xs = v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    if (xs.length) return xs;
  }
  return DEFAULT_RUNGS;
}

/**
 * Shallow-dip sniper (spot, long-only) — a crashcatch mutation tuned for chop, not crashes.
 * Rests LIMIT BUYs at shallow depths (−0.6 / −1.2 / −2 / −3% default) instead of crashcatch's
 * deep −1 / −2 / −3.5 / −5%, each rungFrac of equity, and takes profit fast (+0.5%). Each BUY
 * arms a take-profit SELL tpPct up; each TP re-arms the BUY tpPct down — so shallow rungs + a
 * tight TP recycle quickly through many small dips (the "re-arm quicker" mutation). LIMIT-only
 * (maker), onFill-driven: identical live and in backtest. Static ladder (rungs rest until wicked;
 * no cancel/reseed — resting LIMITs carry no id the strategy can cancel, same as crashcatch).
 */
class CrashSnipe implements Strategy {
  readonly id = 'crashsnipe';
  readonly warmupBars = 1;
  private ctx!: ExecutionContext;
  private p: P = { rungPcts: DEFAULT_RUNGS, tpPct: 0.005, rungFrac: 0.2 };
  private laid = false;

  init(ctx: ExecutionContext, params: StrategyParams): void {
    this.ctx = ctx;
    this.applyParams(params);
  }

  applyParams(params: StrategyParams): void {
    if ('rungPcts' in params) this.p.rungPcts = parseRungs(params.rungPcts);
    if (typeof params.tpPct === 'number') this.p.tpPct = params.tpPct;
    if (typeof params.rungFrac === 'number') this.p.rungFrac = params.rungFrac;
  }

  warmup(_bars: Bar[]): void {}

  onBar(bar: Bar): void {
    if (this.laid) return;
    const mid = bar.close;
    if (mid <= 0) return;
    const pos = this.ctx.position();
    let quoteLeft = Math.max(this.ctx.equityUsdt() - pos.qty * mid, 0); // cash bounds the BUY rungs
    let placed = 0;
    for (const d of this.p.rungPcts) {
      const price = mid * (1 - d);
      const qty = fixedFractionQty(this.ctx, price, this.p.rungFrac);
      if (qty <= 0) continue;
      const cost = price * qty;
      if (cost > quoteLeft) continue;
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price, qty });
      quoteLeft -= cost;
      placed++;
    }
    if (placed > 0) this.laid = true;
  }

  onFill(f: Fill): void {
    if (!this.laid) return;
    // BUY (dip caught) -> take-profit SELL tpPct up; TP SELL -> re-arm BUY tpPct down.
    if (f.side === 'BUY') {
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price * (1 + this.p.tpPct), qty: f.qty });
    } else {
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: f.price * (1 - this.p.tpPct), qty: f.qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'crashsnipe',
  paramSchema: {
    rungPcts: { type: 'string', default: '0.006,0.012,0.02,0.03', desc: 'comma-separated dip depths below mid (fractions)' },
    tpPct: { type: 'number', default: 0.005, min: 0.002, max: 0.05, desc: 'take-profit above each entry (0.005 = 0.5%)' },
    rungFrac: { type: 'number', default: 0.2, min: 0.01, max: 0.25, desc: 'equity fraction per rung' },
  },
  create: () => new CrashSnipe(),
};

export default factory;
