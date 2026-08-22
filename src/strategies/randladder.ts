import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';

/** Deterministic PRNG (mulberry32) — same seed ⇒ same rung depths live and in backtest. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface P {
  tpPct: number; // take-profit above each entry (0.008 = 0.8%)
  rungFrac: number; // equity fraction per rung
  seed: number; // PRNG seed
  minDepthPct: number; // shallowest random rung depth (percent below mid)
  maxDepthPct: number; // deepest random rung depth (percent below mid)
  rungs: number; // number of LIMIT rungs
}

/**
 * CONTROL for the dip-ladder family (spot, long-only). Structurally IDENTICAL to crashcatch — N
 * LIMIT BUY rungs, rungFrac of equity each, every fill mirrored to a TP SELL tpPct up and every TP
 * re-armed tpPct back down — except the rung DEPTHS are drawn UNIFORM-RANDOM in
 * [minDepthPct, maxDepthPct] from a seeded PRNG instead of hand-picked (crashcatch's −1/2/3.5/5%).
 * Purpose: isolate whether the family's edge is depth-SELECTION skill or merely the structure
 * ("LIMIT ladder + shallow TP"). No hidden smartness — the ONLY difference from crashcatch is the
 * random depths.
 *
 * The seed makes the draw reproducible. Like crashcatch (and per the framework's no-cancel limit)
 * the ladder is STATIC — laid once, never re-anchored — so a fair structural control lays once too;
 * the depths are therefore drawn a single time from the seed (redraw() is the would-be re-anchor
 * hook). LIMIT-only, onFill-driven → identical live and in backtest.
 */
class RandLadder implements Strategy {
  readonly id = 'randladder';
  readonly warmupBars = 1;
  private ctx!: ExecutionContext;
  private p: P = { tpPct: 0.008, rungFrac: 0.2, seed: 4242, minDepthPct: 0.5, maxDepthPct: 5, rungs: 4 };
  private depths: number[] = []; // rung depths (fractions below mid), drawn from the seed at lay time
  private laid = false;

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

  warmup(_bars: Bar[]): void {}

  /** Draw rung depths (fractions) uniform-random in [minDepthPct, maxDepthPct] from the seed. */
  private redraw(): void {
    const rng = mulberry32(this.p.seed);
    const lo = this.p.minDepthPct / 100;
    const hi = this.p.maxDepthPct / 100;
    const n = Math.max(1, Math.floor(this.p.rungs));
    this.depths = Array.from({ length: n }, () => lo + rng() * (hi - lo));
  }

  onBar(bar: Bar): void {
    if (this.laid) return;
    const mid = bar.close;
    if (mid <= 0) return;
    this.redraw();
    const pos = this.ctx.position();
    let quoteLeft = Math.max(this.ctx.equityUsdt() - pos.qty * mid, 0); // cash bounds the BUY rungs
    let placed = 0;
    for (const d of this.depths) {
      const price = mid * (1 - d);
      if (price <= 0) continue;
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
    // BUY (wick caught) -> take-profit SELL tpPct up; TP SELL -> re-arm BUY tpPct below its exit.
    if (f.side === 'BUY') {
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price * (1 + this.p.tpPct), qty: f.qty });
    } else {
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: f.price * (1 - this.p.tpPct), qty: f.qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'randladder',
  paramSchema: {
    tpPct: { type: 'number', default: 0.008, min: 0.002, max: 0.05, desc: 'take-profit above each entry (0.008 = 0.8%)' },
    rungFrac: { type: 'number', default: 0.2, min: 0.01, max: 0.25, desc: 'equity fraction per rung' },
    seed: { type: 'number', default: 4242, min: 0, max: 4294967295, desc: 'PRNG seed for the random rung depths' },
    minDepthPct: { type: 'number', default: 0.5, min: 0.1, max: 50, desc: 'shallowest random rung depth (percent below mid)' },
    maxDepthPct: { type: 'number', default: 5, min: 0.1, max: 50, desc: 'deepest random rung depth (percent below mid)' },
    rungs: { type: 'number', default: 4, min: 1, max: 12, desc: 'number of LIMIT rungs' },
  },
  create: () => new RandLadder(),
};

export default factory;
