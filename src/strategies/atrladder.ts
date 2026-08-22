import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';
import { atr } from '../indicators/atr';

const WARMUP = 60; // preload enough history to seed ATR at the first bar (must exceed atrLen)

interface P {
  atrLen: number; // bars of 1m ATR for the realized-volatility estimate
  tpAtrMult: number; // take-profit above each entry, in units of ATR%
  rungFrac: number; // equity fraction per rung
}

/**
 * Volatility-scaled dip ladder (spot, long-only) — crashcatch generalized. Instead of fixed
 * -1/-2/-3.5/-5% rungs, it measures the symbol's own realized volatility as ATR% (atrLen-bar ATR
 * / price) and rests 4 BUY rungs at rungAtrMults × ATR% below the reference mid. On a 16%-range
 * name the rungs sit deep; on a quiet name they tighten in to where price actually reaches — so
 * the same ladder fills across regimes rather than sitting dead (crashcatch stays unfilled on
 * low-range OPN/MUB). Each fill arms a take-profit tpAtrMult × ATR% up; each TP re-arms its BUY.
 * ATR% is frozen at lay time so every rung and its TP share one volatility snapshot.
 *
 * Re-anchor: identical to crashcatch — a strategy only learns an orderId from a Fill, so unfilled
 * resting rungs have no id to cancel. Per crashcatch's fallback it lays a STATIC ladder once; deep
 * BUYs simply rest until price wicks to them (the lottery behavior), no capital lost while waiting.
 * LIMIT-only, onFill-driven → identical live and in backtest.
 */
class AtrLadder implements Strategy {
  readonly id = 'atrladder';
  readonly warmupBars = WARMUP;
  private ctx!: ExecutionContext;
  private p: P = { atrLen: 30, tpAtrMult: 1.5, rungFrac: 0.2 };
  private mults: number[] = [2, 4, 7, 10]; // rung depths as multiples of ATR% (param rungAtrMults)
  private bars: Bar[] = []; // rolling buffer (≤ atrLen+1) to compute ATR
  private laid = false;
  private atrPct = 0; // realized volatility snapshot frozen at lay time; spaces TP / re-arm

  init(ctx: ExecutionContext, params: StrategyParams): void {
    this.ctx = ctx;
    this.applyParams(params);
  }

  applyParams(params: StrategyParams): void {
    for (const k of Object.keys(this.p) as (keyof P)[]) {
      const v = params[k];
      if (typeof v === 'number') this.p[k] = v;
    }
    // rungAtrMults arrives as a comma-string ("2,4,7,10") — the param system is scalar-only.
    const m = params.rungAtrMults;
    if (typeof m === 'string') {
      const parsed = m.split(',').map(Number).filter((x) => Number.isFinite(x) && x > 0);
      if (parsed.length) this.mults = parsed;
    }
  }

  warmup(bars: Bar[]): void {
    this.bars = bars.slice(-(this.p.atrLen + 1));
  }

  private pushBar(b: Bar): void {
    this.bars.push(b);
    while (this.bars.length > this.p.atrLen + 1) this.bars.shift();
  }

  onBar(bar: Bar): void {
    this.pushBar(bar);
    if (this.laid) return;
    const ref = bar.close;
    if (ref <= 0) return;
    const atrPct = atr(this.bars, this.p.atrLen) / ref;
    if (!(atrPct > 0)) return; // need a volatility estimate before laying the ladder
    const pos = this.ctx.position();
    let quoteLeft = Math.max(this.ctx.equityUsdt() - pos.qty * ref, 0); // cash bounds the BUY rungs
    let placed = 0;
    for (const k of this.mults) {
      const price = ref * (1 - k * atrPct);
      if (price <= 0) continue;
      const qty = fixedFractionQty(this.ctx, price, this.p.rungFrac);
      if (qty <= 0) continue;
      const cost = price * qty;
      if (cost > quoteLeft) continue;
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price, qty });
      quoteLeft -= cost;
      placed++;
    }
    if (placed > 0) {
      this.laid = true;
      this.atrPct = atrPct;
    }
  }

  onFill(f: Fill): void {
    if (!this.laid) return;
    const tp = this.p.tpAtrMult * this.atrPct;
    // BUY (wick caught) -> take-profit SELL tp up; TP SELL -> re-arm BUY tp below its exit.
    if (f.side === 'BUY') {
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price * (1 + tp), qty: f.qty });
    } else {
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: f.price * (1 - tp), qty: f.qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'atrladder',
  paramSchema: {
    atrLen: { type: 'number', default: 30, min: 5, max: 50, desc: 'bars of 1m ATR for the realized-volatility estimate' },
    rungAtrMults: { type: 'string', default: '2,4,7,10', desc: 'comma rung depths as multiples of ATR% below mid' },
    tpAtrMult: { type: 'number', default: 1.5, min: 0.25, max: 8, desc: 'take-profit above each entry, in units of ATR%' },
    rungFrac: { type: 'number', default: 0.2, min: 0.01, max: 0.25, desc: 'equity fraction per rung (4 rungs)' },
  },
  create: () => new AtrLadder(),
};

export default factory;
