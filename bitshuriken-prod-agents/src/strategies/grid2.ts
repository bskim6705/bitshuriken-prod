import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';

const SEED_HELD_FRAC = 0.8; // treat inventory as seeded once ≥80% of target is held (resume-safe)
const SEED_RETRY_BARS = 3; // bars to wait between seeding retries
const SEED_MAX_ATTEMPTS = 10; // stop retrying a 0-fill seed after this many submits

interface P {
  levels: number; // rungs seeded per side (below AND above mid)
  spacingPct: number; // gap between rungs, as a fraction (0.001 = 0.1%)
  orderFrac: number; // equity fraction per rung
  invFrac: number; // equity fraction market-bought once to seed SELL-side base inventory
}

/**
 * Two-sided inventory grid (spot). First seeds base inventory with one market buy
 * (invFrac of equity), then lays `levels` BUY rungs below mid and `levels` SELL rungs
 * above. Each fill mirrors one rung across mid (buy → take-profit sell one step up, sell →
 * re-arm buy one step down), so it harvests two-way oscillation instead of only dips like
 * long-only `grid`. SELL rungs require held base, so rungs are capped by available base
 * (sells) / quote cash (buys) — no naked shorts, no over-commit. onFill-driven: runs
 * identically live and in backtest. The seeding buy pays taker fee + slippage up front.
 */
class Grid2 implements Strategy {
  readonly id = 'grid2';
  readonly warmupBars = 1;
  private ctx!: ExecutionContext;
  private p: P = { levels: 6, spacingPct: 0.001, orderFrac: 0.06, invFrac: 0.5 };
  private gridSeeded = false; // rungs have been laid
  private seedPending = false; // seeding market-buy submitted, its fill(s) not yet consumed
  private seedExpectedQty = 0; // approx base qty of the seed, to consume across partial fills
  private seedFilledQty = 0; // cumulative taker-buy qty attributed to the seed
  private seedAttempts = 0; // seeding MARKET buys submitted (bounded retry on 0-fill)
  private barsSinceSeed = 0; // bars since the last seed attempt (spaces out retries)
  private seedGaveUp = false; // warned + stopped retrying after the attempt cap

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
    if (this.gridSeeded) return;
    const mid = bar.close;
    const pos = this.ctx.position();

    // Target base inventory the seed aims to hold (invFrac of equity at mid). Resume/restart
    // resets strategy state but the broker re-syncs the real position, so gate seeding on what's
    // actually held: already ≥80% of target → skip the market buy (no double-seeding on resume).
    const targetInv = mid > 0 ? (this.ctx.equityUsdt() * Math.min(this.p.invFrac, 1)) / mid : 0;
    if (targetInv > 0 && pos.qty < targetInv * SEED_HELD_FRAC) {
      // step 1: buy base inventory so SELL rungs have something to sell. Fills a bar or two later
      // (market latency); if it 0-fills (thin book) we retry, spaced out and capped so a
      // persistently empty book can't spam MARKET orders.
      if (this.seedPending && this.barsSinceSeed < SEED_RETRY_BARS) {
        this.barsSinceSeed++;
        return;
      }
      if (this.seedAttempts >= SEED_MAX_ATTEMPTS) {
        if (!this.seedGaveUp) {
          this.ctx.log.warn(`grid2 seed failed after ${SEED_MAX_ATTEMPTS} attempts (position still ~0) — grid not laid`);
          this.seedGaveUp = true;
        }
        return;
      }
      const quoteQty = this.ctx.equityUsdt() * Math.min(this.p.invFrac, 1);
      if (quoteQty > 0) {
        void this.ctx.submit({ kind: 'MARKET_QUOTE', side: 'BUY', quoteQty });
        this.seedPending = true;
        this.seedExpectedQty = quoteQty / mid; // pre-fee/slippage estimate; consumed with tolerance
        this.seedAttempts++;
        this.barsSinceSeed = 0;
      }
      return;
    }

    // step 2: lay the two-sided grid around mid, each side capped by available inventory.
    const qty = fixedFractionQty(this.ctx, mid, this.p.orderFrac);
    if (qty <= 0) return; // wait until equity/price allow a rung
    let baseLeft = Math.max(pos.qty, 0); // held base bounds the SELL rungs
    let quoteLeft = Math.max(this.ctx.equityUsdt() - pos.qty * mid, 0); // cash bounds the BUY rungs
    for (let i = 1; i <= this.p.levels; i++) {
      const buyPx = mid * (1 - i * this.p.spacingPct);
      if (buyPx > 0 && quoteLeft >= buyPx * qty) {
        void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: buyPx, qty });
        quoteLeft -= buyPx * qty;
      }
      const sellPx = mid * (1 + i * this.p.spacingPct);
      if (baseLeft >= qty) {
        void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: sellPx, qty });
        baseLeft -= qty;
      }
    }
    this.gridSeeded = true;
  }

  onFill(f: Fill): void {
    // Consume the inventory-seeding fill exactly once, independent of arrival order. The seed is
    // grid2's only taker (MARKET) order and a BUY; rungs rest as maker LIMITs. Live delivers fills
    // via async /account/trades polling, so the seed fill can arrive after the grid is laid — the
    // old gridSeeded guard would then mirror the whole seed into one SELL. Match by taker BUY and
    // consume up to the expected seed qty (tolerance covers fee/slippage and partial fills).
    if (this.seedPending && f.side === 'BUY' && !f.isMaker) {
      this.seedFilledQty += f.qty;
      if (this.seedFilledQty >= this.seedExpectedQty * 0.95) this.seedPending = false;
      return;
    }
    if (!this.gridSeeded) return; // rungs not laid yet; nothing to mirror
    // mirror each fill one rung across mid: a buy arms a take-profit sell, a sell re-arms a buy.
    if (f.side === 'BUY') {
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price * (1 + this.p.spacingPct), qty: f.qty });
    } else {
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: f.price * (1 - this.p.spacingPct), qty: f.qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'grid2',
  paramSchema: {
    levels: { type: 'number', default: 6, min: 1, max: 50, desc: 'rungs seeded per side (below and above mid)' },
    spacingPct: { type: 'number', default: 0.001, min: 0.0005, max: 0.1, desc: 'rung gap as a fraction (0.001 = 0.1%)' },
    orderFrac: { type: 'number', default: 0.06, min: 0.005, max: 0.5, desc: 'equity fraction per rung' },
    invFrac: { type: 'number', default: 0.5, min: 0, max: 1, desc: 'equity fraction market-bought once to seed base inventory' },
  },
  create: () => new Grid2(),
};

export default factory;
