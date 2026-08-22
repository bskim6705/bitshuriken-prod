import type { Bar, ExecutionContext, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';

interface P {
  thresholdBps: number; // min |close/open-1| of the completed bar to call it a burst
  tpBps: number; // take-profit in bps from entry
  slBps: number; // stop-loss in bps from entry
  posFrac: number; // equity fraction per entry
  proximityFrac: number; // close must sit within this fraction of the bar range from its extreme
}

/**
 * 1-minute burst chaser (spot, long-only taker). On each completed bar, if its body
 * |close/open-1| clears thresholdBps AND the close sits in the top proximityFrac of the
 * bar's range (an up-burst that closed near its high), it market-buys posFrac of equity.
 * While long it market-flattens when profit ≥ tpBps, loss ≥ slBps, or a down-burst prints
 * (spot can't short — treat the bearish explosion as an exit). One position at a time.
 */
class Burst implements Strategy {
  readonly id = 'burst';
  readonly warmupBars = 1;
  private ctx!: ExecutionContext;
  private p: P = { thresholdBps: 40, tpBps: 60, slBps: 30, posFrac: 0.5, proximityFrac: 0.25 };

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
    const pos = this.ctx.position();
    const changeBps = bar.open > 0 ? (bar.close / bar.open - 1) * 10000 : 0;
    const range = bar.high - bar.low;
    const nearHigh = range <= 0 || bar.close >= bar.high - this.p.proximityFrac * range;
    const nearLow = range <= 0 || bar.close <= bar.low + this.p.proximityFrac * range;
    const upBurst = changeBps >= this.p.thresholdBps && nearHigh;
    const downBurst = changeBps <= -this.p.thresholdBps && nearLow;

    if (pos.qty > 0) {
      // manage the open long: take-profit, stop-loss, or bearish-burst exit
      const pnlBps = pos.avgEntry > 0 ? (bar.close / pos.avgEntry - 1) * 10000 : 0;
      if (pnlBps >= this.p.tpBps || pnlBps <= -this.p.slBps || downBurst) {
        void this.ctx.submit({ kind: 'FLATTEN' });
      }
      return; // one position at a time — no pyramiding
    }

    // flat: chase an up-burst with a market (taker) buy
    if (upBurst) {
      const qty = fixedFractionQty(this.ctx, bar.close, this.p.posFrac);
      if (qty > 0) void this.ctx.submit({ kind: 'MARKET', side: 'BUY', qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'burst',
  paramSchema: {
    thresholdBps: { type: 'number', default: 40, min: 1, max: 1000, desc: 'min bar body |close/open-1| in bps to call a burst' },
    tpBps: { type: 'number', default: 60, min: 1, max: 2000, desc: 'take-profit in bps from entry' },
    slBps: { type: 'number', default: 30, min: 1, max: 2000, desc: 'stop-loss in bps from entry' },
    posFrac: { type: 'number', default: 0.5, min: 0.01, max: 1, desc: 'equity fraction per entry' },
    proximityFrac: { type: 'number', default: 0.25, min: 0.01, max: 1, desc: 'close within this fraction of the bar range from its extreme' },
  },
  create: () => new Burst(),
};

export default factory;
