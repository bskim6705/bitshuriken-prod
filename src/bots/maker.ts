import type { LocalExchangeClient } from '../exchange';
import { floorQty, meetsMinNotional, roundPrice } from '../precision';
import type { DepthSnapshot, Level, Side, SymbolSpec } from '../types';
import { makeLogger, type Logger } from '../log';

interface Resting {
  id: string;
  qty: number;
}

/** Live-tunable maker knobs. */
export interface MakerParams {
  reconcileMs?: number;
  qtyTolerance?: number;
  maxNotional?: number;
  depthLevels?: number;
}

/**
 * Mirrors an external top-N book onto the local exchange as resting limit orders.
 * Each depth snapshot updates the target; a throttled reconcile loop places/cancels
 * the minimum set of orders to match it.
 */
export class MakerBot {
  private static readonly seenErrors = new Set<string>(); // log each distinct rejection once
  private latest: DepthSnapshot | null = null;
  private readonly bids = new Map<string, Resting>(); // priceStr -> resting
  private readonly asks = new Map<string, Resting>();
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private readonly log: Logger;

  // per-SIDE resting-notional budget. Futures: 40% of the account maxNotional. Spot: unbounded.
  // External depth dwarfs the local cap, so without this the maker's futures orders are rejected.
  private perSideNotional: number;

  constructor(
    private readonly client: LocalExchangeClient,
    private readonly spec: SymbolSpec,
    private levels: number,
    private reconcileMs: number,
    private maxNotional = Infinity,
    private qtyTolerance = 0.2,
  ) {
    this.log = makeLogger(`maker:${spec.market === 'FUTURES' ? 'F:' : ''}${spec.symbol}`);
    this.perSideNotional = spec.market === 'FUTURES' ? maxNotional * 0.4 : Infinity;
  }

  setParams(p: MakerParams): void {
    if (p.qtyTolerance !== undefined) this.qtyTolerance = p.qtyTolerance;
    if (p.depthLevels !== undefined) this.levels = p.depthLevels;
    if (p.maxNotional !== undefined) {
      this.maxNotional = p.maxNotional;
      this.perSideNotional = this.spec.market === 'FUTURES' ? this.maxNotional * 0.4 : Infinity;
    }
    if (p.reconcileMs !== undefined && p.reconcileMs !== this.reconcileMs) {
      this.reconcileMs = p.reconcileMs;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = setInterval(() => void this.reconcile(), this.reconcileMs);
      }
    }
  }

  status(): { restingBids: number; restingAsks: number } {
    return { restingBids: this.bids.size, restingAsks: this.asks.size };
  }

  onDepth = (depth: DepthSnapshot): void => {
    this.latest = depth;
  };

  start(): void {
    this.timer = setInterval(() => void this.reconcile(), this.reconcileMs);
  }

  /** snap external levels to the local grid, dedup by tick, drop sub-min-notional dust. */
  private buildTargets(levels: Level[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const [price, qty] of levels.slice(0, this.levels)) {
      const p = roundPrice(this.spec, price);
      const pn = Number(p);
      const q = Number(floorQty(this.spec, qty));
      if (q <= 0 || !meetsMinNotional(this.spec, pn, q)) continue;
      out.set(p, (out.get(p) ?? 0) + q);
    }
    return this.fitNotional(out);
  }

  /** scale qty down so Σ price·qty ≤ perSideNotional (no-op for spot / already-small books). */
  private fitNotional(targets: Map<string, number>): Map<string, number> {
    if (!isFinite(this.perSideNotional)) return targets;
    let total = 0;
    for (const [p, q] of targets) total += Number(p) * q;
    if (total <= this.perSideNotional) return targets;
    const scale = this.perSideNotional / total;
    const out = new Map<string, number>();
    for (const [p, q] of targets) {
      const scaled = Number(floorQty(this.spec, q * scale));
      if (scaled > 0 && meetsMinNotional(this.spec, Number(p), scaled)) out.set(p, scaled);
    }
    return out;
  }

  private async reconcile(): Promise<void> {
    if (this.reconciling || !this.latest) return;
    this.reconciling = true;
    try {
      await this.reconcileSide('BUY', this.bids, this.buildTargets(this.latest.bids));
      await this.reconcileSide('SELL', this.asks, this.buildTargets(this.latest.asks));
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileSide(
    side: Side,
    current: Map<string, Resting>,
    target: Map<string, number>,
  ): Promise<void> {
    const ops: Promise<unknown>[] = [];

    for (const [price, resting] of current) {
      if (!target.has(price)) {
        current.delete(price);
        ops.push(this.cancel(resting.id, price));
      }
    }
    for (const [price, qty] of target) {
      const resting = current.get(price);
      if (!resting) {
        ops.push(this.place(side, price, qty, current));
      } else if (Math.abs(resting.qty - qty) / qty > this.qtyTolerance) {
        current.delete(price);
        ops.push(this.cancel(resting.id, price).then(() => this.place(side, price, qty, current)));
      }
    }
    await Promise.allSettled(ops);
  }

  private async place(
    side: Side,
    price: string,
    qty: number,
    current: Map<string, Resting>,
  ): Promise<void> {
    const qtyStr = floorQty(this.spec, qty);
    try {
      const order = await this.client.placeLimit(this.spec, side, price, qtyStr);
      current.set(price, { id: order.id, qty });
    } catch (e) {
      // expected churn (price-band / insufficient) — log each DISTINCT message once so a
      // systemic rejection (e.g. futures notional cap) is never silently swallowed.
      const msg = (e as Error).message;
      const key = `${this.spec.market}:${side}:${msg}`;
      if (!MakerBot.seenErrors.has(key)) {
        MakerBot.seenErrors.add(key);
        this.log.warn(`place rejected (${side})`, msg);
      }
    }
  }

  private async cancel(id: string, price: string): Promise<void> {
    try {
      await this.client.cancel(this.spec.market, id);
    } catch {
      /* already gone (filled/cancelled) */ void price;
    }
  }

  /** cancel everything (shutdown / restart). */
  async clear(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const all = [...this.bids.values(), ...this.asks.values()];
    this.bids.clear();
    this.asks.clear();
    await Promise.allSettled(all.map((r) => this.cancel(r.id, '')));
    if (this.spec.market === 'SPOT') {
      await this.client.cancelAllSpot(this.spec.symbol).catch(() => {});
    }
  }
}
