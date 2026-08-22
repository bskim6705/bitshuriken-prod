import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';

interface P {
  levels: number; // BUY rungs below mid
  spacing: number; // rung gap and TP step, as a fraction
  orderFrac: number; // equity fraction per rung
  tpSteps: number; // exit tranches fanned above each entry
}

/**
 * Fan-out dip harvester (spot, long-only). Lays `levels` BUY rungs below mid. When a rung
 * fills, instead of one take-profit it fans the exit into `tpSteps` SELL tranches at widening
 * prices (+1, +2, ... x spacing) — banking a quick partial while letting the rest ride a
 * bigger bounce. Each SELL fill re-arms a BUY one spacing below, recycling inventory back
 * into the ladder. onFill-driven; long-only and cash-guarded, so no over-commit; the broker
 * drops any tranche under min-notional. Creative twist on grid2: staggered scale-out exits.
 */
class Fanout implements Strategy {
  readonly id = 'fanout';
  readonly warmupBars = 1;
  private ctx!: ExecutionContext;
  private p: P = { levels: 3, spacing: 0.005, orderFrac: 0.08, tpSteps: 2 };
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
    const pos = this.ctx.position();
    let quoteLeft = Math.max(this.ctx.equityUsdt() - pos.qty * mid, 0);
    let placed = 0;
    for (let i = 1; i <= this.p.levels; i++) {
      const price = mid * (1 - i * this.p.spacing);
      if (price <= 0) continue;
      const qty = fixedFractionQty(this.ctx, price, this.p.orderFrac);
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
      // fan the exit into tpSteps tranches at widening TP levels (broker floors qty / drops dust)
      const n = Math.max(1, Math.floor(this.p.tpSteps));
      const part = f.qty / n;
      for (let k = 1; k <= n; k++) {
        void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price * (1 + k * this.p.spacing), qty: part });
      }
    } else {
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: f.price * (1 - this.p.spacing), qty: f.qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'fanout',
  paramSchema: {
    levels: { type: 'number', default: 3, min: 1, max: 12, desc: 'BUY rungs below mid' },
    spacing: { type: 'number', default: 0.005, min: 0.001, max: 0.05, desc: 'rung gap and TP step as a fraction' },
    orderFrac: { type: 'number', default: 0.08, min: 0.005, max: 0.3, desc: 'equity fraction per rung' },
    tpSteps: { type: 'number', default: 2, min: 1, max: 5, desc: 'exit tranches fanned above each entry' },
  },
  create: () => new Fanout(),
};

export default factory;
