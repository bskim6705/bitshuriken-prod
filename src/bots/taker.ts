import { ApiError, type LocalExchangeClient } from '../exchange';
import { floorQty, meetsMinNotional, toFixedStr } from '../precision';
import type { AggTrade, SymbolSpec } from '../types';
import { makeLogger, type Logger } from '../log';

/**
 * Replays external aggregate trades onto the local book as market orders.
 *
 * External trade rate is decoupled from local order rate: incoming qty accumulates into
 * per-side buffers and a flush loop emits at most `maxTps` orders/sec, each capped to a
 * fraction of the local best level so the print stays at top-of-book (≈ source price)
 * instead of walking the thin mirrored book. Net volume is preserved because dropped/
 * coalesced qty stays in the buffer.
 */
export class TakerBot {
  private pendingBuy = 0;
  private pendingSell = 0;
  private bestBid = 0;
  private bestAsk = 0;
  private bestBidQty = 0;
  private bestAskQty = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private readonly log: Logger;

  constructor(
    private readonly client: LocalExchangeClient,
    private readonly spec: SymbolSpec,
    private maxQtyFrac: number,
    private maxTps: number,
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
    const cap = Math.max(this.bestBidQty, this.bestAskQty, t.qty) * 5;
    if (side === 'BUY') this.pendingBuy = Math.min(this.pendingBuy + t.qty, cap);
    else this.pendingSell = Math.min(this.pendingSell + t.qty, cap);
  };

  start(): void {
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), 1000);
    this.flushTimer = setInterval(() => void this.flush(), Math.max(50, 1000 / this.maxTps));
  }

  private async poll(): Promise<void> {
    try {
      const d = await this.client.depth(this.spec.market, this.spec.symbol, 5);
      this.bestBid = d.bids[0]?.[0] ?? 0;
      this.bestBidQty = d.bids[0]?.[1] ?? 0;
      this.bestAsk = d.asks[0]?.[0] ?? 0;
      this.bestAskQty = d.asks[0]?.[1] ?? 0;
    } catch {
      /* transient */
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      if (this.pendingBuy > 0 && this.bestAsk > 0 && this.bestAskQty > 0) {
        const q = Math.min(this.pendingBuy, this.maxQtyFrac * this.bestAskQty);
        if (await this.market('BUY', q, this.bestAsk)) this.pendingBuy -= q;
      }
      if (this.pendingSell > 0 && this.bestBid > 0 && this.bestBidQty > 0) {
        const q = Math.min(this.pendingSell, this.maxQtyFrac * this.bestBidQty);
        if (await this.market('SELL', q, this.bestBid)) this.pendingSell -= q;
      }
    } finally {
      this.flushing = false;
    }
  }

  private async market(side: 'BUY' | 'SELL', qty: number, refPrice: number): Promise<boolean> {
    const baseQty = floorQty(this.spec, qty);
    if (Number(baseQty) <= 0 || !meetsMinNotional(this.spec, refPrice, Number(baseQty))) return false;
    const quoteQty = toFixedStr(Number(baseQty) * refPrice, this.spec.pricePrecision);
    try {
      await this.client.placeMarket(this.spec, side, baseQty, quoteQty);
      return true;
    } catch (e) {
      // no liquidity / balance — drop this slice, buffer keeps the rest
      if (!(e instanceof ApiError)) this.log.warn('market failed', (e as Error).message);
      return false;
    }
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
  }
}
