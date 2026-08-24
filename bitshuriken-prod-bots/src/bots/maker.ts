import type { LocalExchangeClient } from '../exchange';
import { floorQty, meetsMinNotional, snapPrice, toFixedStr } from '../precision';
import type { DepthSnapshot, Level, Side, SymbolSpec } from '../types';
import { makeLogger, type Logger } from '../log';

interface Resting {
  id: string;
  qty: number; // remaining qty (refreshed from open-orders on resync)
}

/** best remaining price in a resting map (min for asks, max for bids); null when empty. */
function bound(m: Map<string, Resting>, pick: (...v: number[]) => number): number | null {
  if (m.size === 0) return null;
  return pick(...[...m.keys()].map(Number));
}

const anyKeyGte = (m: Map<string, number>, x: number): boolean =>
  [...m.keys()].some((k) => Number(k) >= x);
const anyKeyLte = (m: Map<string, number>, x: number): boolean =>
  [...m.keys()].some((k) => Number(k) <= x);

const minNonNull = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);
const maxNonNull = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

/** Live-tunable maker knobs. */
export interface MakerParams {
  reconcileMs?: number;
  qtyTolerance?: number;
  maxNotional?: number;
  depthLevels?: number;
}

/**
 * Mirrors an external top-N book onto the local exchange as resting POST_ONLY orders.
 *
 * Event-driven: each depth update marks the book dirty; a paced loop applies the minimal
 * diff since the last pass (cancel levels that left, place levels that entered, top up
 * eaten qty). Passes are capped at PASS_OPS_CAP levels per side, best-first, so even a
 * fast move that displaces the whole window walks across passes — touch first, deep
 * levels after, the rest of the book still resting — never a full-book
 * cancel-everything/place-everything wave.
 *
 * Self-cross safety is layered: within a pass every cancel (both sides) completes before
 * any place, and orders are POST_ONLY so the engine rejects a still-crossing order instead
 * of matching it against our own stale opposite side. A rejected level simply reappears in
 * a later diff once the stale order is gone.
 *
 * A slow resync loop re-reads open orders to learn what the diff loop can't see: partial
 * fills by the taker (remaining qty drops → topped up via the qty tolerance), async
 * POST_ONLY rejects, and any leaked/duplicate orders from lost responses.
 */
// Re-log window for repeated rejections: each distinct message logs at most once per window,
// per bot instance (per symbol). A persistent systemic failure (balance exhausted, band reject)
// therefore keeps surfacing instead of being silenced forever after its first occurrence.
const WARN_EVERY_MS = 60_000;

// Max levels touched per side per pass, best-first. Bounds how much of the book is ever
// in flight at once: a full-window displacement walks over ~levels/CAP passes while the
// untouched remainder keeps resting, and the engine sees small op batches, not floods.
const DEFAULT_PASS_OPS_CAP = 15;

export class MakerBot {
  private readonly lastWarn = new Map<string, number>(); // distinct message → last logged at
  private latest: DepthSnapshot | null = null;
  private pending = false; // a snapshot arrived since the last pass
  private stopped = false;
  private lastResync = 0;
  private posQty = 0; // futures position (refreshed on resync) — steers reduceOnly quoting
  private bids = new Map<string, Resting>(); // priceStr -> resting
  private asks = new Map<string, Resting>();
  private readonly log: Logger;

  // per-SIDE resting-notional budget. Spot: unbounded. Futures: 25% of the per-symbol
  // maxNotional — the BE counts |position| + open-order remainders + the new order against that
  // cap, so both sides' books (2×25%) must leave headroom for position drift from taker fills
  // and for in-flight replacement overlap (a cancel not yet applied while its successor lands).
  // At 40% the cap rejected most placements and the futures book sat empty.
  private perSideNotional: number;

  constructor(
    private readonly client: LocalExchangeClient,
    private readonly spec: SymbolSpec,
    private levels: number,
    private reconcileMs: number,
    private maxNotional = Infinity,
    private qtyTolerance = 0.2,
    private readonly resyncMs = 5_000,
    private readonly passOpsCap = DEFAULT_PASS_OPS_CAP,
  ) {
    this.log = makeLogger(`maker:${spec.market === 'FUTURES' ? 'F:' : ''}${spec.symbol}`);
    this.perSideNotional = spec.market === 'FUTURES' ? maxNotional * 0.25 : Infinity;
  }

  setParams(p: MakerParams): void {
    if (p.qtyTolerance !== undefined) this.qtyTolerance = p.qtyTolerance;
    if (p.depthLevels !== undefined) this.levels = p.depthLevels;
    if (p.reconcileMs !== undefined) this.reconcileMs = p.reconcileMs;
    if (p.maxNotional !== undefined) {
      this.maxNotional = p.maxNotional;
      this.perSideNotional = this.spec.market === 'FUTURES' ? this.maxNotional * 0.25 : Infinity;
    }
  }

  status(): { restingBids: number; restingAsks: number } {
    return { restingBids: this.bids.size, restingAsks: this.asks.size };
  }

  onDepth = (depth: DepthSnapshot): void => {
    this.latest = depth;
    this.pending = true;
  };

  start(): void {
    void this.loop();
  }

  // One serialized loop per symbol: resync (slow cadence) and diff pass (when a fresh
  // snapshot is waiting) never overlap, so the resting maps have a single writer.
  private async loop(): Promise<void> {
    while (!this.stopped) {
      const started = Date.now();
      try {
        if (started - this.lastResync >= this.resyncMs) {
          this.lastResync = started;
          await this.resync();
        }
        if (this.pending && this.latest) {
          this.pending = false;
          await this.reconcile(this.latest);
        }
      } catch (e) {
        this.warnOnce('pass', (e as Error).message);
      }
      const elapsed = Date.now() - started;
      await sleep(Math.max(this.reconcileMs - elapsed, 25));
    }
  }

  /** snap external levels to the local grid, dedup by tick, drop sub-min-notional dust. */
  private buildTargets(levels: Level[], side: Side): Map<string, number> {
    const out = new Map<string, number>();
    for (const [price, qty] of levels.slice(0, this.levels)) {
      const p = snapPrice(this.spec, price, side); // bids floor / asks ceil — rounding never crosses
      const pn = Number(p);
      const q = Number(floorQty(this.spec, qty));
      if (q <= 0 || !meetsMinNotional(this.spec, pn, q)) continue;
      out.set(p, (out.get(p) ?? 0) + q);
    }
    return this.fitNotional(out, side);
  }

  // sticky per-side notional scale. Recomputing scale=budget/total every pass makes EVERY level's
  // target qty jitter with the external book's total — all levels then breach qtyTolerance together
  // and the whole side cancel/replaces every pass (measured: futures orders lived 0.4–0.8s, book
  // effectively empty). Reuse the last scale while it stays within tolerance and inside 1.25×
  // budget, so per-level churn is again proportional to per-level change, like spot.
  private readonly stickyScale: Record<Side, number> = { BUY: 1, SELL: 1 };

  /** scale qty down so Σ price·qty ≤ perSideNotional (no-op for spot / already-small books). */
  private fitNotional(targets: Map<string, number>, side: Side): Map<string, number> {
    if (!isFinite(this.perSideNotional)) return targets;
    let total = 0;
    for (const [p, q] of targets) total += Number(p) * q;
    if (total <= this.perSideNotional && this.stickyScale[side] >= 1) return targets;
    const fresh = Math.min(1, this.perSideNotional / total);
    const last = this.stickyScale[side];
    const scale =
      Math.abs(fresh / last - 1) <= this.qtyTolerance && last * total <= this.perSideNotional * 1.25
        ? last
        : fresh;
    this.stickyScale[side] = scale;
    if (scale >= 1) return targets;
    const out = new Map<string, number>();
    for (const [p, q] of targets) {
      const scaled = Number(floorQty(this.spec, q * scale));
      if (scaled > 0 && meetsMinNotional(this.spec, Number(p), scaled)) out.set(p, scaled);
    }
    return out;
  }

  private async reconcile(depth: DepthSnapshot): Promise<void> {
    let targetBids = this.buildTargets(depth.bids, 'BUY');
    let targetAsks = this.buildTargets(depth.asks, 'SELL');

    // engine-truth touch — sees resting orders our own maps can't: FOREIGN orders (another
    // user's stray quote) and our own opposite orders whose cancel hasn't applied yet.
    let touchBid: number | null = null;
    let touchAsk: number | null = null;
    try {
      const top = await this.client.depth(this.spec.market, this.spec.symbol, 1);
      touchBid = top.bids[0]?.[0] ?? null;
      touchAsk = top.asks[0]?.[0] ?? null;
    } catch {
      /* transient — the own-map guards below still apply */
    }

    // A FOREIGN order resting inside our target range POST_ONLY-rejects every quote past it
    // (e.g. a stray dust bid parked above the real market). Clamp the target to the levels
    // strictly inside the obstruction and keep mirroring those — the withheld levels stay
    // deferred until the taker clears the obstruction (its dust rule takes such levels whole
    // within a few flushes). Clamping beats holding the whole side: the book keeps tracking
    // the source below the stray order instead of freezing entirely behind it (the 07-12
    // "$5.8 dust order froze the book +0.4%" failure mode).
    const ownAskMin = bound(this.asks, Math.min);
    const ownBidMax = bound(this.bids, Math.max);
    const bidsBlocked =
      touchAsk !== null && (ownAskMin === null || touchAsk < ownAskMin) && anyKeyGte(targetBids, touchAsk);
    const asksBlocked =
      touchBid !== null && (ownBidMax === null || touchBid > ownBidMax) && anyKeyLte(targetAsks, touchBid);
    if (bidsBlocked)
      targetBids = new Map([...targetBids].filter(([p]) => Number(p) < (touchAsk as number)));
    if (asksBlocked)
      targetAsks = new Map([...targetAsks].filter(([p]) => Number(p) > (touchBid as number)));

    const buy = this.planSide(this.bids, targetBids, true);
    const sell = this.planSide(this.asks, targetAsks, false);

    // every cancel of THIS pass (both sides) lands before any place: an up-move's new bids
    // are only sent after the stale asks they'd cross are already being pulled.
    const cancels = [...buy.cancels, ...sell.cancels];
    if (cancels.length) await Promise.allSettled(cancels.map((id) => this.cancel(id)));

    // place-guard: own post-cancel opposite side AND the engine touch. A level past either
    // waits for a later pass instead of being POST_ONLY-rejected into a phantom (the touch
    // read predates this pass's cancels, so a displaced touch clears by the next pass).
    const askGuard = minNonNull(bound(this.asks, Math.min), touchAsk);
    const bidGuard = maxNonNull(bound(this.bids, Math.max), touchBid);
    let deferred = buy.deferred || sell.deferred || bidsBlocked || asksBlocked;
    const places: Promise<void>[] = [];
    for (const [price, qty] of buy.places) {
      if (askGuard !== null && Number(price) >= askGuard) deferred = true;
      else places.push(this.place('BUY', price, qty, this.bids));
    }
    for (const [price, qty] of sell.places) {
      if (bidGuard !== null && Number(price) <= bidGuard) deferred = true;
      else places.push(this.place('SELL', price, qty, this.asks));
    }
    if (places.length) await Promise.allSettled(places);
    if (deferred) this.pending = true; // keep walking on the next pass
  }

  /**
   * Per-side pass plan, capped at PASS_OPS_CAP levels, best-first. A big move (the whole
   * window displaced) therefore walks across passes — the touch updates first, deep levels
   * follow, and the rest of the book stays resting — instead of one full-book
   * cancel-everything/place-everything wave that leaves the book empty in between.
   */
  private planSide(
    current: Map<string, Resting>,
    target: Map<string, number>,
    isBid: boolean,
  ): { cancels: string[]; places: [string, number][]; deferred: boolean } {
    // one entry per touched price: cancel (left target / qty drifted) and/or place (new / drifted)
    const ops = new Map<string, { cancel?: Resting; place?: number }>();
    for (const [price, resting] of current) {
      if (!target.has(price)) ops.set(price, { cancel: resting });
    }
    for (const [price, qty] of target) {
      const resting = current.get(price);
      if (resting && Math.abs(resting.qty - qty) / qty <= this.qtyTolerance) continue;
      ops.set(price, { cancel: resting, place: qty });
    }
    const prices = [...ops.keys()].sort((a, b) => (isBid ? Number(b) - Number(a) : Number(a) - Number(b)));

    const cancels: string[] = [];
    const places: [string, number][] = [];
    for (const price of prices.slice(0, this.passOpsCap)) {
      const op = ops.get(price)!;
      if (op.cancel) {
        current.delete(price);
        cancels.push(op.cancel.id);
      }
      if (op.place !== undefined) places.push([price, op.place]);
    }
    return { cancels, places, deferred: prices.length > this.passOpsCap };
  }

  /**
   * Re-read open orders and rebuild the resting maps from exchange truth: remaining qty
   * (origQty - executedQty) replaces the placed qty, orders gone from the book (filled,
   * async PO-reject) drop out, duplicates at one price (a lost place response later
   * adopted here) are cancelled.
   */
  private async resync(): Promise<void> {
    if (this.spec.market === 'FUTURES') {
      // position drives reduceOnly quoting (see place()) — refresh it at resync cadence
      try {
        const pos = (await this.client.positions(this.spec.symbol)).find(
          (p) => p.symbol === this.spec.symbol,
        );
        this.posQty = pos ? Number(pos.qty) : 0;
      } catch {
        /* keep the last known position */
      }
    }
    const open = await this.client.openOrders(this.spec.market, this.spec.symbol);
    const next = { BUY: new Map<string, Resting>(), SELL: new Map<string, Resting>() };
    const dupes: string[] = [];
    for (const o of open) {
      if (o.price == null || o.origQty == null || (o.side !== 'BUY' && o.side !== 'SELL')) continue;
      const price = toFixedStr(Number(o.price), this.spec.pricePrecision);
      const remaining = Number(o.origQty) - Number(o.executedQty);
      if (remaining <= 0) continue;
      const m = next[o.side];
      if (m.has(price)) dupes.push(o.id);
      else m.set(price, { id: o.id, qty: remaining });
    }
    this.bids = next.BUY;
    this.asks = next.SELL;
    if (dupes.length) await Promise.allSettled(dupes.map((id) => this.cancel(id)));
  }

  private async place(
    side: Side,
    price: string,
    qty: number,
    current: Map<string, Resting>,
  ): Promise<void> {
    const qtyStr = floorQty(this.spec, qty);
    try {
      const order = await this.client.placePostOnly(this.spec, side, price, qtyStr, this.reduceOnlyFor(side, qty, current));
      current.set(price, { id: order.id, qty });
    } catch (e) {
      // expected churn (price-band / insufficient) — log each DISTINCT message once so a
      // systemic rejection (e.g. futures notional cap) is never silently swallowed.
      this.warnOnce(`place:${side}`, (e as Error).message, ` [price=${price} qty=${qtyStr}]`);
    }
  }

  /**
   * Flag a futures quote reduceOnly when it reduces the account's position and fits (with the
   * side's already-resting qty) inside HALF the position. Purpose: a maker pinned at the
   * direction-blind maxNotional cap (|position|+open+new ≤ cap) can otherwise place NOTHING —
   * its reducing side must quote cap-exempt so the taker's flatten flow can unwind both
   * accounts. The 50% clamp keeps concurrent fills from over-reducing through zero.
   */
  private reduceOnlyFor(side: Side, qty: number, current: Map<string, Resting>): boolean {
    if (this.spec.market !== 'FUTURES' || this.posQty === 0) return false;
    const reduces = this.posQty > 0 ? side === 'SELL' : side === 'BUY';
    if (!reduces) return false;
    let resting = 0;
    for (const r of current.values()) resting += r.qty;
    return resting + qty <= 0.5 * Math.abs(this.posQty);
  }

  private async cancel(id: string): Promise<void> {
    try {
      await this.client.cancel(this.spec.market, id);
    } catch {
      /* already gone (filled/cancelled) */
    }
  }

  /** `detail` is logged but excluded from the dedup key (per-order values would defeat it). */
  private warnOnce(what: string, msg: string, detail = ''): void {
    const key = `${what}:${msg}`;
    const now = Date.now();
    if (now - (this.lastWarn.get(key) ?? 0) < WARN_EVERY_MS) return;
    this.lastWarn.set(key, now);
    this.log.warn(`${what} failed`, msg + detail);
  }

  /**
   * Cancel everything (shutdown / restart), VERIFIED against exchange truth. Cancels time out
   * silently when the BE is backlogged at shutdown — that left ghost books resting on delisted
   * mirror symbols (measured: 90+ orphans/symbol). So after the sweep, re-read open orders and
   * retry the leftovers; log loudly if any survive, a real exchange never keeps phantom quotes.
   */
  async clear(): Promise<void> {
    this.stopped = true;
    const tracked = [...this.bids.values(), ...this.asks.values()];
    this.bids.clear();
    this.asks.clear();
    await Promise.allSettled(tracked.map((r) => this.cancel(r.id)));
    if (this.spec.market === 'SPOT') {
      await this.client.cancelAllSpot(this.spec.symbol).catch(() => {});
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sleep(2000); // cancels are async (BE→engine→consumer) — let them land before verifying
      try {
        const open = await this.client.openOrders(this.spec.market, this.spec.symbol);
        if (open.length === 0) return;
        this.log.warn(`clear: ${open.length} orders still open — retrying (${attempt}/3)`);
        await Promise.allSettled(open.map((o) => this.cancel(o.id)));
      } catch (e) {
        this.log.warn('clear: verify read failed', (e as Error).message);
      }
    }
    const left = await this.client.openOrders(this.spec.market, this.spec.symbol).catch(() => []);
    if (left.length > 0) this.log.err(`clear FAILED: ${left.length} ghost orders remain — run npm run sweep`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
