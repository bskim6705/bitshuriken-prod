import type { Bar, ExecutionContext, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';

/** Baseline: buy once with all equity on the first final bar, then hold forever. */
class BuyAndHold implements Strategy {
  readonly id = 'buy-and-hold';
  readonly warmupBars = 0;
  private ctx!: ExecutionContext;
  private bought = false;

  init(ctx: ExecutionContext, _params: StrategyParams): void {
    this.ctx = ctx;
  }
  applyParams(_params: StrategyParams): void {}
  warmup(_bars: Bar[]): void {}

  onBar(_bar: Bar): void {
    if (this.bought) return;
    this.bought = true;
    void this.ctx.submit({ kind: 'MARKET_QUOTE', side: 'BUY', quoteQty: this.ctx.equityUsdt() });
  }
}

const factory: StrategyFactory = {
  id: 'buy-and-hold',
  paramSchema: {},
  create: () => new BuyAndHold(),
};

export default factory;
