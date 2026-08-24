import { ApiError, type LocalExchangeClient } from '../exchange';
import { ceilPrice, floorPrice, floorQty, meetsMinNotional } from '../precision';
import type { AggTrade, Level, SymbolSpec } from '../types';
import { makeLogger, type Logger } from '../log';

/**
 * Replays external aggregate trades onto the local book as marketable-limit (IOC) orders.
 *
 * External trade rate is decoupled from local order rate: incoming qty accumulates into
 * per-side buffers and a flush loop emits at most `maxTps` orders/sec per side.
 *
 * Price: each order is a LIMIT IOC capped at max(source print price, local touch) for a BUY
 * (min for a SELL) — the source-price-cap decision of ADR-070. When the source printed a
 * multi-level sweep, the local order sweeps exactly up to that price too, so wicks and candle
 * H/L reproduce; the limit is a structural ceiling, so it can never walk past the source print
 * into deep resting orders (the 07-12 MARKET-replay artifact). The watermark is the extreme
 * print price buffered since the last flush of that side, and resets once a flush lands.
 */
const TOUCH_POLL_MS = 250;
const WARN_EVERY_MS = 60_000; // repeated order-rejection messages re-log once per window

// Futures inventory hygiene. Replay fills accumulate position on BOTH bot accounts (maker and
// taker hold exact opposite exposure); once |position|·mark reaches the per-symbol maxNotional
// cap the BE rejects every further quote and the book dies (measured: all four futures accounts
// pinned at ~1.0M). The taker flattens because its aggressive reduceOnly IOC crosses the MAKER's
// book — one flow shrinks both accounts symmetrically. (The maker can't flatten itself: its
// aggressive order would hit its own resting opposite side and the self-trade nets to zero.)
const INVENTORY_POLL_MS = 2_000;
const FLATTEN_AT = 0.3; // start flattening above this fraction of maxNotional
const FLATTEN_TO = 0.15; // ...and aim back down to this fraction
const FLATTEN_MAX_FRAC = 1.0; // per pass, take at most this fraction of the opposing best level

export class TakerBot {
  private pendingBuy = 0;
  private pendingSell = 0;
  private sweepBuy = 0; // max source print price buffered since the last BUY flush
  private sweepSell = Infinity; // min source print price buffered since the last SELL flush
  private bids: Level[] = [];
  private asks: Level[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private inventoryTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private flattening = false;
  private posQty = 0; // futures position (refreshed by the inventory loop)
  private readonly lastWarn = new Map<string, number>();
  private readonly log: Logger;

  constructor(
    private readonly client: LocalExchangeClient,
    private readonly spec: SymbolSpec,
    private maxQtyFrac: number,
    private maxTps: number,
    private readonly maxNotional = Infinity,
  ) {
    this.log = makeLogger(`taker:${spec.market === 'FUTURES' ? 'F:' : ''}${spec.symbol}`);
  }

  setParams(p: { maxQtyFrac?: number; maxTps?: number }): void {
    if (p.maxQtyFrac !== undefined) this.maxQtyFrac = p.maxQtyFrac;
    if (p.maxTps !== undefined && p.maxTps !== this.maxTps) {
      this.maxTps = p.maxTps;
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = setInterval(() => void this.flush(), Math.max(50, 1000 / this.maxTps));
      }
    }
  }

  status(): { pendingBuy: number; pendingSell: number } {
    return { pendingBuy: this.pendingBuy, pendingSell: this.pendingSell };
  }

  onTrade = (t: AggTrade): void => {
    const side: 'BUY' | 'SELL' = t.buyerIsMaker ? 'SELL' : 'BUY';
    // cap buffers so a source burst we can't absorb doesn't accumulate forever
    const bestBidQty = this.bids[0]?.[1] ?? 0;
    const bestAskQty = this.asks[0]?.[1] ?? 0;
    const cap = Math.max(bestBidQty, bestAskQty, t.qty) * 5;
    if (side === 'BUY') {
      this.pendingBuy = Math.min(this.pendingBuy + t.qty, cap);
      if (t.price > this.sweepBuy) this.sweepBuy = t.price;
    } else {
      this.pendingSell = Math.min(this.pendingSell + t.qty, cap);
      if (t.price < this.sweepSell) this.sweepSell = t.price;
    }
  };

  start(): void {
    void this.poll();
    // touch must be fresh relative to the flush cadence — a stale touch replays prints at
    // prices the book has already left (shaved wicks, missed fills).
    this.pollTimer = setInterval(() => void this.poll(), TOUCH_POLL_MS);
    this.flushTimer = setInterval(() => void this.flush(), Math.max(50, 1000 / this.maxTps));
    if (this.spec.market === 'FUTURES' && isFinite(this.maxNotional)) {
      this.inventoryTimer = setInterval(() => void this.flattenInventory(), INVENTORY_POLL_MS);
    }
  }

  /** shed futures exposure back under FLATTEN_TO×maxNotional once it exceeds FLATTEN_AT×. */
  private async flattenInventory(): Promise<void> {
    if (this.flattening) return;
    this.flattening = true;
    try {
      const pos = (await this.client.positions(this.spec.symbol)).find(
        (p) => p.symbol === this.spec.symbol,
      );
      this.posQty = pos ? Number(pos.qty) : 0;
      if (!pos || this.posQty === 0) return;
      const qty = this.posQty;
      const mark = Number(pos.markPrice) || (qty > 0 ? this.bids[0]?.[0] : this.asks[0]?.[0]) || 0;
      if (mark <= 0 || Math.abs(qty) * mark <= FLATTEN_AT * this.maxNotional) return;
      const excess = Math.abs(qty) - (FLATTEN_TO * this.maxNotional) / mark;
      // closing a LONG sells into the bids; closing a SHORT buys from the asks
      const [side, levels] = qty > 0 ? (['SELL', this.bids] as const) : (['BUY', this.asks] as const);
      const best = levels[0];
      if (!best) return;
      const q = floorQty(this.spec, Math.min(excess, FLATTEN_MAX_FRAC * best[1]));
      if (Number(q) <= 0) return;
      const price = side === 'SELL' ? floorPrice(this.spec, best[0]) : ceilPrice(this.spec, best[0]);
      await this.client.placeReduceOnlyIoc(this.spec.symbol, side, price, q);
      this.log.info(`inventory flatten: ${side} ${q} @ ${price} (|pos| ${Math.abs(qty).toFixed(4)})`);
    } catch (e) {
      const msg = (e as Error).message;
      const now = Date.now();
      if (now - (this.lastWarn.get(msg) ?? 0) >= WARN_EVERY_MS) {
        this.lastWarn.set(msg, now);
        this.log.warn('inventory flatten failed', msg);
      }
    } finally {
      this.flattening = false;
    }
  }

  private async poll(): Promise<void> {
    try {
      const d = await this.client.depth(this.spec.market, this.spec.symbol, 5);
      this.bids = d.bids;
      this.asks = d.asks;
    } catch {
      /* transient */
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      // inventory-aware replay: while exposure is past the flatten threshold, pause the side
      // that would grow it further — otherwise replay adds position as fast as flatten sheds it
      // and the unwind never converges (measured: ETH pinned around ~880k notional).
      const bid = this.bids[0]?.[0] ?? 0;
      const ask = this.asks[0]?.[0] ?? 0;
      const mark = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
      const overExposed =
        this.spec.market === 'FUTURES' && Math.abs(this.posQty) * mark > FLATTEN_AT * this.maxNotional;
      const skipBuy = overExposed && this.posQty > 0;
      const skipSell = overExposed && this.posQty < 0;
      if (!skipBuy && this.pendingBuy > 0 && this.asks.length) {
        const cap = Math.max(this.sweepBuy, this.asks[0]![0]);
        const q = this.slice(this.pendingBuy, this.asks, cap, (p) => p <= cap);
        if (q > 0 && (await this.take('BUY', q, ceilPrice(this.spec, cap), cap))) {
          this.pendingBuy -= q;
          this.sweepBuy = 0;
        }
      }
      if (!skipSell && this.pendingSell > 0 && this.bids.length) {
        const cap = Math.min(this.sweepSell, this.bids[0]![0]);
        const q = this.slice(this.pendingSell, this.bids, cap, (p) => p >= cap);
        if (q > 0 && (await this.take('SELL', q, floorPrice(this.spec, cap), cap))) {
          this.pendingSell -= q;
          this.sweepSell = Infinity;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Order slice for one flush.
   * - Touch-only flush (cap at the best level): a fraction of the best level, so replay doesn't
   *   constantly empty the touch and flicker the book.
   * - Sweep flush (cap beyond the touch — the source printed through several levels): everything
   *   resting within the cap, bounded by the buffered source volume, so the local book sweeps to
   *   the same price the source did.
   * - A DUST best level is taken whole instead: a tiny stray order at the touch can't be
   *   fractionally taken above minNotional and the POST_ONLY maker can't quote through it, so a
   *   fractional-only taker would deadlock the book behind it. Qty is padded up to minNotional —
   *   safe, because the IOC can only fill what rests at/inside its limit.
   */
  private slice(pending: number, levels: Level[], cap: number, inCap: (p: number) => boolean): number {
    const [bestPrice, bestQty] = levels[0]!;
    if (bestQty * bestPrice <= 2 * this.spec.minNotional) {
      return Math.min(pending, Math.max(bestQty, (this.spec.minNotional * 1.01) / bestPrice));
    }
    if (inCap(levels[1]?.[0] ?? NaN)) {
      // sweep: more than the touch is inside the cap — take all resting qty within it
      const takeable = levels.reduce((s, [p, q]) => (inCap(p) ? s + q : s), 0);
      return Math.min(pending, takeable);
    }
    return Math.min(pending, this.maxQtyFrac * bestQty);
  }

  private async take(side: 'BUY' | 'SELL', qty: number, price: string, refPrice: number): Promise<boolean> {
    const baseQty = floorQty(this.spec, qty);
    if (Number(baseQty) <= 0 || !meetsMinNotional(this.spec, refPrice, Number(baseQty))) return false;
    try {
      await this.client.placeLimitIoc(this.spec, side, price, baseQty);
      return true;
    } catch (e) {
      // drop this slice, buffer keeps the rest. Rejections (band/balance/cap) are real signals —
      // log each distinct message with a re-log window instead of swallowing ApiErrors silently.
      const msg = (e as Error).message;
      const now = Date.now();
      if (now - (this.lastWarn.get(msg) ?? 0) >= WARN_EVERY_MS) {
        this.lastWarn.set(msg, now);
        const label = e instanceof ApiError ? 'take rejected' : 'take failed';
        this.log.warn(label, `${msg} [side=${side} price=${price} qty=${baseQty}]`);
      }
      return false;
    }
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.inventoryTimer) clearInterval(this.inventoryTimer);
  }
}
