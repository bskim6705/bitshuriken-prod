import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';

interface P {
  levels: number; // static BUY rungs below mid
  spacingPct: number; // deep rung gap, as a fraction (0.012 = 1.2%)
  sizeMult: number; // martingale size ratio per deeper rung
  baseFrac: number; // equity fraction of the shallowest rung (auto-clamped)
  tpPct: number; // take-profit step above each entry (fanout)
  tpSteps: number; // exit tranches fanned above each entry
}

/**
 * Dip ladder (spot, long-only) — a crashcatch × martingrid × fanout crossover. Lays `levels`
 * static deep BUY rungs below mid (i·spacingPct, crash-style fixed depths), each sized
 * `sizeMult`× the last (martingale: deeper = bigger, pulling avg entry down fast). baseFrac is
 * auto-clamped by the geometric sum so total committed notional never exceeds equity. Each BUY
 * fans its exit into `tpSteps` SELL tranches at widening TP steps (fanout scale-out — bank a
 * quick partial, let the rest ride); each SELL re-arms a BUY tpPct below, recycling inventory.
 * LIMIT-only (maker), onFill-driven: identical live and in backtest. No naked shorts.
 */
class DipLadder implements Strategy {
  readonly id = 'dipladder';
  readonly warmupBars = 1;
  private ctx!: ExecutionContext;
  private p: P = { levels: 4, spacingPct: 0.012, sizeMult: 1.6, baseFrac: 0.05, tpPct: 0.006, tpSteps: 2 };
  private laid = false;

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

  warmup(_bars: Bar[]): void {}

  onBar(bar: Bar): void {
    if (this.laid) return;
    const mid = bar.close;
    if (mid <= 0) return;

    // Clamp the base rung so the geometric series of rung sizes sums to <= equity.
    const m = this.p.sizeMult;
    const N = this.p.levels;
    const geomSum = m === 1 ? N : (Math.pow(m, N) - 1) / (m - 1);
    const baseFracEff = geomSum > 0 ? Math.min(this.p.baseFrac, 1 / geomSum) : 0;
    if (baseFracEff <= 0) return;

    const pos = this.ctx.position();
    let quoteLeft = Math.max(this.ctx.equityUsdt() - pos.qty * mid, 0); // cash bounds the BUY rungs
    let placed = 0;
    for (let i = 1; i <= N; i++) {
      const price = mid * (1 - i * this.p.spacingPct);
      if (price <= 0) continue;
      const frac = baseFracEff * Math.pow(m, i - 1); // martingale: deeper rung, bigger size
      const qty = fixedFractionQty(this.ctx, price, frac);
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
    if (f.side === 'BUY') {
      // fan the exit into tpSteps tranches at widening TP levels (broker floors qty / drops dust).
      const n = Math.max(1, Math.floor(this.p.tpSteps));
      const part = f.qty / n;
      for (let k = 1; k <= n; k++) {
        void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price * (1 + k * this.p.tpPct), qty: part });
      }
    } else {
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: f.price * (1 - this.p.tpPct), qty: f.qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'dipladder',
  paramSchema: {
    levels: { type: 'number', default: 4, min: 1, max: 12, desc: 'static BUY rungs below mid' },
    spacingPct: { type: 'number', default: 0.012, min: 0.001, max: 0.1, desc: 'deep rung gap as a fraction (0.012 = 1.2%)' },
    sizeMult: { type: 'number', default: 1.6, min: 1, max: 4, desc: 'martingale size ratio per deeper rung' },
    baseFrac: { type: 'number', default: 0.05, min: 0.001, max: 0.5, desc: 'equity fraction of the shallowest rung (auto-clamped)' },
    tpPct: { type: 'number', default: 0.006, min: 0.002, max: 0.05, desc: 'take-profit step above each entry (0.006 = 0.6%)' },
    tpSteps: { type: 'number', default: 2, min: 1, max: 5, desc: 'exit tranches fanned above each entry' },
  },
  create: () => new DipLadder(),
};

export default factory;
