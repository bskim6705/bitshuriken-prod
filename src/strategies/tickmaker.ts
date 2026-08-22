import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';
import { depth } from '../core/exchange';

const CAPTURE_TICKS = 2; // round-trip target: exit 2 ticks from entry (≈ 32bps − 20bps fees ≈ +12bps)

interface P {
  minSpreadTicks: number; // at/above this spread, improve by 1 tick; between joinAtTicks and this, join at best
  joinAtTicks: number; // minimum spread (ticks) to quote at all; at exactly this spread, JOIN the best quote
  invCapQuote: number; // max long inventory in quote (USDT); at/above it, quote only the reducing side
  quoteFrac: number; // equity fraction sized per quote (kept small)
}

/**
 * Tick maker (spot) — exploits OPN microstructure where one tick is a large fraction of price
 * (OPN ~0.0613, tick 0.0001 ≈ 16bps). Quotes a two-sided maker book scaled to the spread: when
 * the book is exactly joinAtTicks wide it JOINS the best bid/ask (posts AT best, not inside —
 * capturing the whole 2-tick spread ≈ 32bps gross, +12bps net after fees), and once the book is
 * wider (≥ minSpreadTicks) it improves by one tick as before. Below joinAtTicks it stays out — a
 * 1-tick book can't be quoted without crossing. OrderIntent has no POST_ONLY flag, so a HARD
 * no-cross guard re-derived from each bar's fresh depth (our bid < our ask, and neither side
 * lifts/hits the resting book) is the non-crossing guarantee. Each BUY mirrors to a SELL
 * CAPTURE_TICKS higher (round trip ≥ 2 ticks − 20bps fees ≈ +12bps); each SELL re-arms a BUY,
 * skipped once inventory reaches invCapQuote so the long can't run.
 *
 * Book source: ExecutionContext exposes no order book, so onBar polls the local REST depth
 * endpoint (core/exchange `depth()`, base = SPOT_API) at 1m cadence. That endpoint returns the
 * LIVE local book, so this strategy is LIVE-ONLY: SimBroker replays Binance OHLC with no book and
 * fills any touched limit fully as maker, which would fake a market-maker's edge — it is NOT
 * honestly backtestable. Gate on design review + tiny live capital (fund the subaccount small;
 * sizing is equity-relative). Also: continuous re-quoting on book moves needs a cancel handle the
 * framework doesn't expose for resting LIMITs, so it arms once then mirrors on fills.
 */
class TickMaker implements Strategy {
  readonly id = 'tickmaker';
  readonly warmupBars = 1;
  private ctx!: ExecutionContext;
  private p: P = { minSpreadTicks: 3, joinAtTicks: 2, invCapQuote: 100, quoteFrac: 0.02 };
  private armed = false;

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

  async onBar(bar: Bar): Promise<void> {
    if (this.armed) return; // place the initial two-sided quote once; fills mirror thereafter.
    const mid = bar.close;
    if (mid <= 0) return;
    let book;
    try {
      book = await depth(this.ctx.market, this.ctx.spec.symbol, 5);
    } catch {
      return; // no book (backtest / exchange down) → cannot quote honestly
    }
    const bestBid = book.bids[0]?.[0];
    const bestAsk = book.asks[0]?.[0];
    if (!bestBid || !bestAsk) return;
    const tick = this.ctx.spec.tickSize;
    const spreadTicks = Math.round((bestAsk - bestBid) / tick);
    if (spreadTicks < this.p.joinAtTicks) return; // too tight to quote without crossing

    // At exactly joinAtTicks: JOIN the best (post AT best bid/ask, capturing the full spread).
    // Once the book is ≥ minSpreadTicks wide: improve by one tick and sit inside.
    const join = spreadTicks < this.p.minSpreadTicks;
    const bidPrice = join ? bestBid : bestBid + tick;
    const askPrice = join ? bestAsk : bestAsk - tick;
    // HARD no-cross guard, re-derived from THIS bar's fresh depth: our two quotes must not cross
    // each other, and neither may lift the resting ask or hit the resting bid.
    if (!(bidPrice < askPrice && bidPrice < bestAsk && askPrice > bestBid)) return;

    const qty = fixedFractionQty(this.ctx, mid, this.p.quoteFrac);
    if (qty <= 0) return;
    const invQuote = this.ctx.position().qty * mid;
    // BUY at/above best bid, if inventory has room.
    if (invQuote < this.p.invCapQuote) {
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: bidPrice, qty });
    }
    // SELL at/below best ask, only if we already hold base to sell (long-only spot).
    if (this.ctx.position().qty >= qty) {
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: askPrice, qty });
    }
    this.armed = true;
  }

  onFill(f: Fill): void {
    if (!this.armed) return;
    const tick = this.ctx.spec.tickSize;
    if (f.side === 'BUY') {
      // bank the round trip: offload CAPTURE_TICKS above entry (rests as maker).
      void this.ctx.submit({ kind: 'LIMIT', side: 'SELL', price: f.price + CAPTURE_TICKS * tick, qty: f.qty });
    } else if (this.ctx.position().qty * f.price < this.p.invCapQuote) {
      // re-arm a BUY CAPTURE_TICKS below the sell, unless inventory is already at cap.
      void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: f.price - CAPTURE_TICKS * tick, qty: f.qty });
    }
  }
}

const factory: StrategyFactory = {
  id: 'tickmaker',
  paramSchema: {
    minSpreadTicks: { type: 'number', default: 3, min: 2, max: 20, desc: 'at/above this spread improve by 1 tick; below it (but ≥ joinAtTicks) join at best' },
    joinAtTicks: { type: 'number', default: 2, min: 1, max: 20, desc: 'minimum spread (ticks) to quote; at exactly this spread, JOIN the best quote' },
    invCapQuote: { type: 'number', default: 100, min: 1, max: 100000, desc: 'max long inventory in quote (USDT) before quoting only the reducing side' },
    quoteFrac: { type: 'number', default: 0.02, min: 0.0001, max: 0.5, desc: 'equity fraction sized per quote (kept small)' },
  },
  create: () => new TickMaker(),
};

export default factory;
