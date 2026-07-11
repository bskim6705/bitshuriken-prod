import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';

interface P {
  levels: number; // number of BUY rungs seeded below mid
  spacingPct: number; // gap between rungs, as a fraction (0.004 = 0.4%)
  orderFrac: number; // equity fraction per rung
}

/**
 * Long-only spot grid. Seeds a ladder of BUY limits below mid; each fill places a SELL one
 * step above (taking profit), and each SELL places a BUY one step below — a self-refilling
 * grid that harvests oscillation. onFill-driven, so it runs identically live and in backtest.
 */
class Grid implements Strategy {
  readonly id = 'grid';
  readonly warmupBars = 1;
  private ctx!: ExecutionContext;
  private p: P = { levels: 5, spacingPct: 0.004, orderFrac: 0.05 };
  private seeded = false;

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
    if (this.seeded) return;
    const qty = fixedFractionQty(this.ctx, bar.close, this.p.orderFrac);
    if (qty <= 0) return; // wait until equity/price allow a rung
    for (let i = 1; i <= this.p.levels; i++) {
      const price = bar.close * (1 - i * this.p.spacingPct);
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price, qty });
    }
    this.seeded = true;
  }

  onFill(f: Fill): void {
    // mirror each fill one rung away: a buy sets a take-profit sell, a sell re-arms a buy
    if (f.side === 'BUY') {
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price * (1 + this.p.spacingPct), qty: f.qty });
    } else {
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: f.price * (1 - this.p.spacingPct), qty: f.qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'grid',
  paramSchema: {
    levels: { type: 'number', default: 5, min: 1, max: 50, desc: 'BUY rungs seeded below mid' },
    spacingPct: { type: 'number', default: 0.004, min: 0.0005, max: 0.1, desc: 'rung gap as a fraction (0.004 = 0.4%)' },
    orderFrac: { type: 'number', default: 0.05, min: 0.005, max: 0.5, desc: 'equity fraction per rung' },
  },
  create: () => new Grid(),
};

export default factory;
