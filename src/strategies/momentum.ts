import type { Bar, ExecutionContext, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { ema } from '../indicators/ma';
import { rsi } from '../indicators/rsi';
import { fixedFractionQty } from '../strategy/sizing';

interface P {
  fast: number;
  slow: number;
  rsiLen: number;
  rsiBuy: number;
  rsiSell: number;
  riskFrac: number;
}

/** EMA-crossover momentum with an RSI filter. Long-only (spot). Flattens on exit. */
class Momentum implements Strategy {
  readonly id = 'momentum';
  private ctx!: ExecutionContext;
  private p: P = { fast: 12, slow: 26, rsiLen: 14, rsiBuy: 55, rsiSell: 45, riskFrac: 0.25 };
  private closes: number[] = [];

  get warmupBars(): number {
    return Math.max(this.p.slow, this.p.rsiLen) + 5;
  }

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
    for (const b of bars) this.closes.push(b.close);
  }

  onBar(bar: Bar): void {
    this.closes.push(bar.close);
    if (this.closes.length < this.warmupBars) return;
    const fast = ema(this.closes, this.p.fast);
    const slow = ema(this.closes, this.p.slow);
    const r = rsi(this.closes, this.p.rsiLen);
    const pos = this.ctx.position();

    if (pos.qty <= 0 && fast > slow && r >= this.p.rsiBuy) {
      const qty = fixedFractionQty(this.ctx, bar.close, this.p.riskFrac);
      if (qty > 0) void this.ctx.submit({ kind: 'MARKET', side: 'BUY', qty });
    } else if (pos.qty > 0 && (fast < slow || r <= this.p.rsiSell)) {
      void this.ctx.submit({ kind: 'FLATTEN' });
    }
  }
}

const factory: StrategyFactory = {
  id: 'momentum',
  paramSchema: {
    fast: { type: 'number', default: 12, min: 2, max: 200, desc: 'fast EMA length' },
    slow: { type: 'number', default: 26, min: 3, max: 400, desc: 'slow EMA length' },
    rsiLen: { type: 'number', default: 14, min: 2, max: 100, desc: 'RSI length' },
    rsiBuy: { type: 'number', default: 55, min: 50, max: 90, desc: 'RSI entry threshold' },
    rsiSell: { type: 'number', default: 45, min: 10, max: 50, desc: 'RSI exit threshold' },
    riskFrac: { type: 'number', default: 0.25, min: 0.01, max: 1, desc: 'equity fraction per entry' },
  },
  create: () => new Momentum(),
};

export default factory;
