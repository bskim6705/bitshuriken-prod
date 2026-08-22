import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';

interface P {
  levels: number; // BUY rungs below mid
  spacingPct: number; // gap between rungs, as a fraction (0.004 = 0.4%)
  sizeMult: number; // geometric size ratio per deeper rung (martingale)
  baseFrac: number; // equity fraction of the shallowest (base) rung
}

/**
 * Martingale BUY grid (spot, long-only). Lays `levels` BUY rungs below mid, each rung
 * `spacingPct` deeper and `sizeMult`x larger than the last — so a falling price is met with
 * geometrically bigger buys, pulling the average entry down fast. Each BUY fill arms a
 * take-profit SELL one `spacingPct` above; each TP fill re-arms the original BUY (grid2-style
 * mirror), preserving the martingale shape rung-for-rung. baseFrac is auto-clamped by the
 * geometric sum so total committed notional never exceeds equity. onFill-driven: identical
 * live and in backtest. No naked shorts — SELLs only ever offload just-bought inventory.
 */
class Martingrid implements Strategy {
  readonly id = 'martingrid';
  readonly warmupBars = 1;
  private ctx!: ExecutionContext;
  private p: P = { levels: 5, spacingPct: 0.004, sizeMult: 1.8, baseFrac: 0.03 };
  private laid = false; // rungs have been placed

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

    // Clamp the base rung so the geometric series of rungs sums to <= equity.
    // total notional = baseFrac * equity * (m^N - 1)/(m - 1)  <=  equity
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
    // mirror one step across: a BUY arms a take-profit SELL, a TP SELL re-arms the BUY.
    // f.qty carries each rung's martingale size, so the ladder shape is preserved.
    if (f.side === 'BUY') {
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price * (1 + this.p.spacingPct), qty: f.qty });
    } else {
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: f.price * (1 - this.p.spacingPct), qty: f.qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'martingrid',
  paramSchema: {
    levels: { type: 'number', default: 5, min: 1, max: 12, desc: 'BUY rungs below mid' },
    spacingPct: { type: 'number', default: 0.004, min: 0.0005, max: 0.1, desc: 'rung gap as a fraction (0.004 = 0.4%)' },
    sizeMult: { type: 'number', default: 1.8, min: 1, max: 4, desc: 'geometric size ratio per deeper rung (martingale)' },
    baseFrac: { type: 'number', default: 0.03, min: 0.001, max: 0.5, desc: 'equity fraction of the shallowest rung (auto-clamped by geometric sum)' },
  },
  create: () => new Martingrid(),
};

export default factory;
