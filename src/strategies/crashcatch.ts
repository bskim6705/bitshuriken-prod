import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';

// Fixed dip depths below mid — the "lottery" wick catchers.
const DEPTHS = [0.01, 0.02, 0.035, 0.05];

interface P {
  tpPct: number; // take-profit above each entry (0.008 = 0.8%)
  rungFrac: number; // equity fraction per rung
}

/**
 * Deep-wick lottery ladder (spot, long-only). Rests BUY orders far below mid
 * (-1% / -2% / -3.5% / -5%), each rungFrac of equity, waiting for a flash-crash wick to
 * fill cheap. Each fill arms a take-profit SELL tpPct above its entry; each TP fill re-arms
 * the BUY at its original depth. onFill-driven: identical live and in backtest.
 *
 * Reseed note: the operator's spec asks to CANCEL a fully-unfilled, drifted ladder and
 * re-lay it around the new mid. CANCEL is in the OrderIntent type, but ctx.submit() returns
 * void and a strategy only ever learns an orderId from a Fill — so unfilled resting orders
 * have no id to cancel. Per the spec's fallback ("없으면 재설치 생략하고 정적 사다리로"), this uses
 * a static ladder: deep BUYs simply rest until price wicks down to them, which is exactly the
 * lottery behavior anyway (no capital is lost while waiting).
 */
class CrashCatch implements Strategy {
  readonly id = 'crashcatch';
  readonly warmupBars = 1;
  private ctx!: ExecutionContext;
  private p: P = { tpPct: 0.008, rungFrac: 0.2 };
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
    let quoteLeft = Math.max(this.ctx.equityUsdt() - pos.qty * mid, 0); // cash bounds the BUY rungs
    let placed = 0;
    for (const d of DEPTHS) {
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
    // BUY (wick caught) -> take-profit SELL tpPct up; TP SELL -> re-arm BUY at original depth.
    if (f.side === 'BUY') {
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price * (1 + this.p.tpPct), qty: f.qty });
    } else {
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: f.price * (1 - this.p.tpPct), qty: f.qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'crashcatch',
  paramSchema: {
    tpPct: { type: 'number', default: 0.008, min: 0.002, max: 0.05, desc: 'take-profit above each entry (0.008 = 0.8%)' },
    rungFrac: { type: 'number', default: 0.2, min: 0.01, max: 0.25, desc: 'equity fraction per rung (4 rungs)' },
  },
  create: () => new CrashCatch(),
};

export default factory;
