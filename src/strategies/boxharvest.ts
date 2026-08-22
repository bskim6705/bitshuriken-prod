import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';

// Rung placements as fractions of box height, measured from box_low. The +10% rung sits just
// inside the range low; the −5% rung sits just under it to catch a dip through the low.
const RUNG_OFFSETS = [0.1, -0.05];
const RE_ARM_OFFSET = 0.1; // after a mid TP, re-lay the in-box rung to keep cycling

interface P {
  boxBars: number; // rolling window whose high/low define the box
  minBoxPct: number; // box only trades when height/low ≥ this (fraction, 0.012 = 1.2%)
  rungFrac: number; // equity fraction per rung
  tpFrac: number; // take-profit level inside the box (0.5 = mid)
  shiftPct: number; // re-anchor when box_low drifts by more than this fraction
}

/**
 * Range-box harvester (spot, long-only) — a niche between a grid and a dip-ladder. The box is the
 * high/low of the last boxBars 1m bars; once its height clears minBoxPct it rests two BUY rungs
 * near the low (box_low +10% and −5% of height) and mirrors each fill with a SELL at the box mid
 * (tpFrac). Buy the range low, sell the middle, re-arm on each mid TP → it cycles like a grid while
 * a range holds, but only arms when a real box exists (unlike a grid it sits idle in a trend).
 *
 * Re-anchor: when box_low drifts more than shiftPct the box has moved, so it re-anchors the mid and
 * lays a fresh pair at the new low. This framework can't cancel a resting order (a strategy only
 * learns an orderId from a Fill), so old rungs stay as deep resting bids — harmless below the new
 * market, and a knife-catch if price breaks the old low (their TP mirrors above them). Total resting
 * BUY exposure is capped at equity (outstandingBuy guard) so stacked generations never oversize.
 * LIMIT-only, onFill-driven → identical live and in backtest.
 */
class BoxHarvest implements Strategy {
  readonly id = 'boxharvest';
  readonly warmupBars = 120; // seed a default-size box before the first signal
  private ctx!: ExecutionContext;
  private p: P = { boxBars: 120, minBoxPct: 0.012, rungFrac: 0.25, tpFrac: 0.5, shiftPct: 0.006 };
  private bars: Bar[] = []; // rolling buffer (≤ boxBars) for the box high/low
  private anchorLow = 0; // frozen box low of the active anchor (0 = never laid)
  private anchorHigh = 0;
  private outstandingBuy = 0; // notional of resting BUY rungs, to bound stacked exposure

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
    this.bars = bars.slice(-this.p.boxBars);
  }

  private pushBar(b: Bar): void {
    this.bars.push(b);
    while (this.bars.length > this.p.boxBars) this.bars.shift();
  }

  private tpPrice(): number {
    return this.anchorLow + this.p.tpFrac * (this.anchorHigh - this.anchorLow);
  }

  /** Lay a BUY rung at each offset, sized by rungFrac and bounded by the equity exposure cap. */
  private layRungs(offsets: number[]): void {
    const height = this.anchorHigh - this.anchorLow;
    if (height <= 0) return;
    const equity = this.ctx.equityUsdt();
    for (const off of offsets) {
      const price = this.anchorLow + off * height;
      if (price <= 0) continue;
      const qty = fixedFractionQty(this.ctx, price, this.p.rungFrac);
      if (qty <= 0) continue;
      const cost = price * qty;
      if (this.outstandingBuy + cost > equity) continue; // never let resting bids exceed equity
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price, qty });
      this.outstandingBuy += cost;
    }
  }

  onBar(bar: Bar): void {
    this.pushBar(bar);
    if (this.bars.length < 2) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of this.bars) {
      if (b.low < lo) lo = b.low;
      if (b.high > hi) hi = b.high;
    }
    if (!(lo > 0) || hi <= lo) return;
    const heightFrac = (hi - lo) / lo;
    if (heightFrac < this.p.minBoxPct) return; // no real box → stay idle (unlike a grid)

    if (this.anchorLow === 0) {
      this.anchorLow = lo;
      this.anchorHigh = hi;
      this.layRungs(RUNG_OFFSETS);
      return;
    }
    // Box moved: re-anchor the mid and lay a fresh pair at the new low (exposure-capped).
    if (Math.abs(lo - this.anchorLow) / this.anchorLow > this.p.shiftPct) {
      this.anchorLow = lo;
      this.anchorHigh = hi;
      this.layRungs(RUNG_OFFSETS);
    }
  }

  onFill(f: Fill): void {
    if (this.anchorLow === 0) return;
    if (f.side === 'BUY') {
      this.outstandingBuy = Math.max(0, this.outstandingBuy - f.price * f.qty);
      // Sell at the box mid, floored at entry so a downward re-anchor never rests a losing exit.
      const tp = Math.max(this.tpPrice(), f.price);
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: tp, qty: f.qty });
    } else {
      // Harvested a mid TP → re-arm one in-box rung to catch the next dip (exposure-capped).
      this.layRungs([RE_ARM_OFFSET]);
    }
  }
}

const factory: StrategyFactory = {
  id: 'boxharvest',
  paramSchema: {
    boxBars: { type: 'number', default: 120, min: 20, max: 600, desc: 'rolling window whose high/low define the box' },
    minBoxPct: { type: 'number', default: 0.012, min: 0.002, max: 0.1, desc: 'min box height as a fraction of low to arm (0.012 = 1.2%)' },
    rungFrac: { type: 'number', default: 0.25, min: 0.01, max: 0.5, desc: 'equity fraction per rung' },
    tpFrac: { type: 'number', default: 0.5, min: 0.1, max: 0.95, desc: 'take-profit level inside the box (0.5 = mid)' },
    shiftPct: { type: 'number', default: 0.006, min: 0.001, max: 0.05, desc: 're-anchor when box_low drifts by more than this fraction' },
  },
  create: () => new BoxHarvest(),
};

export default factory;
