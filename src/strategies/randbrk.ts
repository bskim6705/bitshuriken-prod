import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';

const PENDING_TIMEOUT = 4; // bars to wait on an unfilled entry / stuck exit before abandoning-or-retrying

/** Deterministic PRNG (mulberry32) — same seed ⇒ same entry sequence live and in backtest. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface P {
  entryProb: number; // per-bar probability of opening a long while flat
  tpPct: number; // take-profit above entry (fraction)
  slPct: number; // stop-loss below entry (fraction)
  maxBars: number; // time-stop: flatten after this many held bars
  entryFrac: number; // equity fraction spent per entry (quote)
  seed: number; // PRNG seed (integer)
}

/**
 * Random-entry asymmetric bracket (spot, long-only) — a *statistical benchmark*, not a signal.
 * Each bar, while flat, it opens a long with fixed probability entryProb using a seeded PRNG, so
 * live and backtest replay the exact same entries; it then brackets with an asymmetric TP/SL and
 * a maxBars time-stop. Entry timing carries zero information by construction, so any edge lives
 * entirely in the exit geometry: high-vol mirror symbols mean-revert at the 1m horizon, so a
 * tight TP / wider SL harvests the frequent small snap-backs before the rare wide stop fires.
 * Its PnL measures whether the mirror's short-horizon return distribution beats the 20bps
 * round-trip taker cost — the control that tells you how much of any *other* strategy's PnL is
 * real skill vs. this baseline drift. Same flat→long→flat, position()-driven, race-free MARKET
 * exits as the surge-fade sibling.
 */
class RandBracket implements Strategy {
  readonly id = 'randbrk';
  readonly warmupBars = 1;
  private ctx!: ExecutionContext;
  private p: P = { entryProb: 0.25, tpPct: 0.004, slPct: 0.006, maxBars: 6, entryFrac: 0.5, seed: 1337 };
  private rng: () => number = mulberry32(1337);
  private barsHeld = 0;
  private entrySubmitted = false;
  private exitSubmitted = false;
  private entryBars = 0;
  private exitBars = 0;

  init(ctx: ExecutionContext, params: StrategyParams): void {
    this.ctx = ctx;
    this.applyParams(params);
  }

  applyParams(params: StrategyParams): void {
    for (const k of Object.keys(this.p) as (keyof P)[]) {
      const v = params[k];
      if (typeof v === 'number') this.p[k] = v;
    }
    this.rng = mulberry32(this.p.seed); // re-seed so entries stay reproducible after a tune
  }

  warmup(_bars: Bar[]): void {}

  onBar(bar: Bar): void {
    const pos = this.ctx.position();
    const isLong = pos.qty * bar.close >= this.ctx.spec.minNotional; // dust below min-notional counts as flat

    if (isLong) {
      this.entrySubmitted = false;
      this.barsHeld++;
      if (!this.exitSubmitted) {
        const tp = pos.avgEntry * (1 + this.p.tpPct);
        const sl = pos.avgEntry * (1 - this.p.slPct);
        if (bar.high >= tp || bar.low <= sl || this.barsHeld >= this.p.maxBars) {
          void this.ctx.submit({ kind: 'FLATTEN' });
          this.exitSubmitted = true;
          this.exitBars = 0;
        }
      } else if (++this.exitBars > PENDING_TIMEOUT) {
        void this.ctx.submit({ kind: 'FLATTEN' }); // exit didn't take — retry
        this.exitBars = 0;
      }
    } else {
      this.barsHeld = 0;
      this.exitSubmitted = false;
      if (!this.entrySubmitted) {
        if (this.rng() < this.p.entryProb) this.enter();
      } else if (++this.entryBars > PENDING_TIMEOUT) {
        this.entrySubmitted = false; // entry never filled — drop it (RNG already advanced)
      }
    }
  }

  private enter(): void {
    const quoteQty = this.ctx.equityUsdt() * Math.min(this.p.entryFrac, 1);
    if (quoteQty < this.ctx.spec.minNotional) return;
    void this.ctx.submit({ kind: 'MARKET_QUOTE', side: 'BUY', quoteQty });
    this.entrySubmitted = true;
    this.entryBars = 0;
  }

  onFill(f: Fill): void {
    this.ctx.log.info(`randbrk fill ${f.side} ${f.qty}@${f.price} ${f.isMaker ? 'maker' : 'taker'}`);
  }
}

const factory: StrategyFactory = {
  id: 'randbrk',
  paramSchema: {
    entryProb: { type: 'number', default: 0.25, min: 0.01, max: 1, desc: 'per-bar entry probability while flat' },
    tpPct: { type: 'number', default: 0.004, min: 0.001, max: 0.1, desc: 'take-profit above entry (fraction)' },
    slPct: { type: 'number', default: 0.006, min: 0.001, max: 0.1, desc: 'stop-loss below entry (fraction)' },
    maxBars: { type: 'number', default: 6, min: 1, max: 60, desc: 'time-stop in held bars' },
    entryFrac: { type: 'number', default: 0.5, min: 0.01, max: 1, desc: 'equity fraction per entry (quote)' },
    seed: { type: 'number', default: 1337, min: 0, max: 4294967295, desc: 'PRNG seed (integer)' },
  },
  create: () => new RandBracket(),
};

export default factory;
