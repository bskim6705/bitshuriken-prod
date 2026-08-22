import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';
import { returns, stddev, tail } from '../indicators/series';

interface P {
  levels: number; // rungs seeded per side (below AND above mid)
  orderFrac: number; // equity fraction per rung
  invFrac: number; // equity fraction market-bought once to seed SELL-side base inventory
  volWindow: number; // bars of realized-vol lookback (per-bar return stddev)
  volMult: number; // spacing = volMult * realizedVol, before clamping
  minSpacing: number; // spacing floor as a fraction (must sit above the round-trip fee)
  maxSpacing: number; // spacing cap as a fraction
  pauseVolBps: number; // below this realized vol (bps) do not seed new rungs — dead-market rest
  reseedThresh: number; // fractional spacing change that re-arms the working spacing (churn gate)
}

/**
 * Volatility-adaptive two-sided inventory grid (spot). Same seed-then-mirror machine as grid2,
 * but the rung gap tracks realized volatility instead of being fixed: spacing =
 * clamp(volMult * stddev(bar returns over volWindow), minSpacing, maxSpacing). In a dead market
 * (vol < pauseVolBps) it declines to lay the grid at all — no fee-eroding tight rungs on flat tape;
 * in a lively market the gap widens, cutting inventory risk from rungs that would otherwise sit too
 * close. The working spacing only moves when the target shifts by > reseedThresh, so the mirror gap
 * steps with the regime rather than jittering every bar (order-churn control). Because a strategy
 * never learns the id of a resting LIMIT here (submit returns void; sim fills carry no order id),
 * spacing is adapted through the churn-free mirror gap — each fill re-arms its mirror at the current
 * working spacing — rather than by cancelling and re-seeding standing rungs. onFill-driven: runs
 * identically live and in backtest. minSpacing stays above the round-trip fee so every mirror clears.
 */
class GridV implements Strategy {
  readonly id = 'gridv';
  private ctx!: ExecutionContext;
  private p: P = {
    levels: 6,
    orderFrac: 0.06,
    invFrac: 0.5,
    volWindow: 60,
    volMult: 2.0,
    minSpacing: 0.003,
    maxSpacing: 0.012,
    pauseVolBps: 5,
    reseedThresh: 0.2,
  };
  private closes: number[] = [];
  private spacing = 0; // working rung gap; 0 until the first vol reading arms it
  private invSeeded = false; // inventory market-buy has been submitted
  private gridSeeded = false; // rungs have been laid
  private seedPending = false; // seeding market-buy submitted, its fill(s) not yet consumed
  private seedExpectedQty = 0; // approx base qty of the seed, to consume across partial fills
  private seedFilledQty = 0; // cumulative taker-buy qty attributed to the seed

  get warmupBars(): number {
    return this.p.volWindow; // enough closes to read realized vol on the very first live bar
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

  /** Realized per-bar volatility over the last volWindow bars, as a fraction (stddev of returns). */
  private realizedVol(): number {
    return stddev(returns(tail(this.closes, this.p.volWindow + 1)));
  }

  /** Update the working spacing toward the vol-implied target, but only past the churn gate. */
  private tuneSpacing(vol: number): void {
    const target = Math.min(Math.max(this.p.volMult * vol, this.p.minSpacing), this.p.maxSpacing);
    if (this.spacing === 0 || Math.abs(target - this.spacing) / this.spacing > this.p.reseedThresh) {
      this.spacing = target;
    }
  }

  onBar(bar: Bar): void {
    this.closes.push(bar.close);
    const vol = this.realizedVol();
    this.tuneSpacing(vol);

    if (this.gridSeeded) return; // henceforth the grid maintains itself via onFill mirrors

    // Dead-market rest: don't deploy tight rungs onto flat tape (fees would erode them).
    if (vol * 1e4 < this.p.pauseVolBps) return;

    // step 1: buy base inventory so SELL rungs have something to sell. Fills next bar (market
    // latency), so we lay the grid on a later bar once the inventory has landed.
    if (!this.invSeeded) {
      const quoteQty = this.ctx.equityUsdt() * Math.min(this.p.invFrac, 1);
      if (quoteQty > 0) {
        void this.ctx.submit({ kind: 'MARKET_QUOTE', side: 'BUY', quoteQty });
        this.seedPending = true;
        this.seedExpectedQty = quoteQty / bar.close; // pre-fee/slippage estimate; consumed with tolerance
      }
      this.invSeeded = true;
      return;
    }

    // step 2: lay the two-sided grid around mid at the current adaptive spacing, each side capped
    // by available inventory (held base bounds SELLs, cash bounds BUYs) — no naked shorts.
    const mid = bar.close;
    const qty = fixedFractionQty(this.ctx, mid, this.p.orderFrac);
    if (qty <= 0) return; // wait until equity/price allow a rung
    const pos = this.ctx.position();
    let baseLeft = Math.max(pos.qty, 0);
    let quoteLeft = Math.max(this.ctx.equityUsdt() - pos.qty * mid, 0);
    for (let i = 1; i <= this.p.levels; i++) {
      const buyPx = mid * (1 - i * this.spacing);
      if (buyPx > 0 && quoteLeft >= buyPx * qty) {
        void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: buyPx, qty });
        quoteLeft -= buyPx * qty;
      }
      const sellPx = mid * (1 + i * this.spacing);
      if (baseLeft >= qty) {
        void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: sellPx, qty });
        baseLeft -= qty;
      }
    }
    this.gridSeeded = true;
  }

  onFill(f: Fill): void {
    // Consume the inventory-seeding fill exactly once, independent of arrival order (see grid2):
    // it's the only taker BUY, rungs rest as maker LIMITs. Match by taker BUY, consume up to the
    // expected seed qty (tolerance covers fee/slippage and partial fills).
    if (this.seedPending && f.side === 'BUY' && !f.isMaker) {
      this.seedFilledQty += f.qty;
      if (this.seedFilledQty >= this.seedExpectedQty * 0.95) this.seedPending = false;
      return;
    }
    if (!this.gridSeeded) return; // rungs not laid yet; nothing to mirror
    // Mirror each fill one rung across mid at the CURRENT adaptive spacing: a buy arms a take-profit
    // sell one step up, a sell re-arms a buy one step down. This is how spacing adapts without
    // cancelling standing rungs — fresh mirrors carry the up-to-date gap.
    if (f.side === 'BUY') {
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price * (1 + this.spacing), qty: f.qty });
    } else {
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: f.price * (1 - this.spacing), qty: f.qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'gridv',
  paramSchema: {
    levels: { type: 'number', default: 6, min: 1, max: 50, desc: 'rungs seeded per side (below and above mid)' },
    orderFrac: { type: 'number', default: 0.06, min: 0.005, max: 0.5, desc: 'equity fraction per rung' },
    invFrac: { type: 'number', default: 0.5, min: 0, max: 1, desc: 'equity fraction market-bought once to seed base inventory' },
    volWindow: { type: 'number', default: 60, min: 5, max: 500, desc: 'bars of realized-vol lookback' },
    volMult: { type: 'number', default: 2.0, min: 0.1, max: 20, desc: 'spacing = volMult * realized vol (pre-clamp)' },
    minSpacing: { type: 'number', default: 0.003, min: 0.0021, max: 0.1, desc: 'spacing floor as a fraction (above round-trip fee)' },
    maxSpacing: { type: 'number', default: 0.012, min: 0.003, max: 0.2, desc: 'spacing cap as a fraction' },
    pauseVolBps: { type: 'number', default: 5, min: 0, max: 200, desc: 'below this realized vol (bps) do not seed rungs' },
    reseedThresh: { type: 'number', default: 0.2, min: 0.01, max: 2, desc: 'fractional spacing change that re-arms working spacing' },
  },
  create: () => new GridV(),
};

export default factory;
