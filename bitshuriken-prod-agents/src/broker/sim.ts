import { makeLogger, type Logger } from '../core/logger';
import { floorQty } from '../core/precision';
import type { Bar, Market, SymbolSpec } from '../core/types';
import type { ExecutionContext, Fill, OrderIntent, Position } from '../strategy/types';
import type { EquityPoint, LedgerFill } from '../metrics/types';

export interface SimConfig {
  feeBps: number;
  slippageBps: number;
  latencyBars: number;
}

interface DueMarket {
  id: string;
  fillIndex: number;
  side: 'BUY' | 'SELL';
  /** base qty (for MARKET/FLATTEN) or null when sized from quote at fill time. */
  qty: number | null;
  quoteQty: number | null;
}

interface RestingLimit {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
}

/**
 * Deterministic backtest broker: market orders fill `latencyBars` later at the bar
 * open (± slippage); limit orders fill when a later bar crosses them. Keeps a cash +
 * position ledger so equity, PnL and fills are reproducible from the bar series alone.
 */
export class SimBroker implements ExecutionContext {
  readonly market: Market;
  readonly log: Logger;
  private cash: number;
  private pos: Position = { qty: 0, avgEntry: 0 };
  private mark = 0;
  private nowMs = 0;
  private index = 0;
  private dueMarkets: DueMarket[] = [];
  private restingLimits: RestingLimit[] = [];
  private seq = 0;
  private fillCb: ((f: Fill) => void) | null = null;
  private readonly fills: LedgerFill[] = [];
  private readonly curve: EquityPoint[] = [];

  constructor(
    readonly spec: SymbolSpec,
    private readonly initialCapital: number,
    private readonly cfg: SimConfig,
  ) {
    this.market = spec.market;
    this.cash = initialCapital;
    this.log = makeLogger(`sim:${spec.symbol}`);
  }

  // ---- ExecutionContext ----
  position(): Position {
    return { ...this.pos };
  }
  equityUsdt(): number {
    return this.cash + this.pos.qty * this.mark;
  }
  now(): number {
    return this.nowMs;
  }
  onFill(cb: (f: Fill) => void): void {
    this.fillCb = cb;
  }

  submit(intent: OrderIntent): Promise<string | null> {
    const fillIndex = this.index + Math.max(1, this.cfg.latencyBars);
    switch (intent.kind) {
      case 'MARKET': {
        const id = `M${++this.seq}`;
        this.dueMarkets.push({ id, fillIndex, side: intent.side, qty: intent.qty, quoteQty: null });
        return Promise.resolve(id);
      }
      case 'MARKET_QUOTE': {
        const id = `M${++this.seq}`;
        this.dueMarkets.push({ id, fillIndex, side: intent.side, qty: null, quoteQty: intent.quoteQty });
        return Promise.resolve(id);
      }
      case 'FLATTEN':
        if (this.pos.qty > 0)
          this.dueMarkets.push({ id: `M${++this.seq}`, fillIndex, side: 'SELL', qty: this.pos.qty, quoteQty: null });
        else if (this.pos.qty < 0)
          this.dueMarkets.push({ id: `M${++this.seq}`, fillIndex, side: 'BUY', qty: -this.pos.qty, quoteQty: null });
        return Promise.resolve(null);
      case 'LIMIT': {
        // postOnly: 현재 mark를 즉시 크로스하는 가격이면 거래소의 POST_ONLY 거절을 모사
        if (intent.postOnly === true && this.mark > 0) {
          const crosses = intent.side === 'BUY' ? intent.price >= this.mark : intent.price <= this.mark;
          if (crosses) return Promise.resolve(null);
        }
        const id = `L${++this.seq}`;
        this.restingLimits.push({ id, side: intent.side, price: intent.price, qty: intent.qty });
        return Promise.resolve(id);
      }
      case 'CANCEL':
        this.restingLimits = this.restingLimits.filter((l) => l.id !== intent.orderId);
        return Promise.resolve(null);
    }
  }

  // ---- engine-facing ----
  /** start processing bar `index`: fill due market orders at the open, cross resting limits. */
  beginBar(index: number, bar: Bar): void {
    this.index = index;
    this.nowMs = bar.openTime;
    const stillDue: DueMarket[] = [];
    for (const m of this.dueMarkets) {
      if (m.fillIndex <= index) this.execMarket(m, bar.open);
      else stillDue.push(m);
    }
    this.dueMarkets = stillDue;
    // Cross a snapshot of the current book; onFill (via tryCrossLimit→fill→fillCb) may submit
    // new limits into this.restingLimits, so drain it first and merge those new orders back in.
    // New orders are not re-crossed this bar (they become active next bar — latency semantics).
    const toCross = this.restingLimits;
    this.restingLimits = [];
    const kept: RestingLimit[] = [];
    for (const l of toCross) {
      if (!this.tryCrossLimit(l, bar)) kept.push(l);
    }
    this.restingLimits = kept.concat(this.restingLimits);
    this.mark = bar.close;
  }

  /** close bar `index`: append an equity sample at the bar close. */
  endBar(bar: Bar): void {
    this.mark = bar.close;
    this.curve.push({ t: bar.closeTime, equity: this.equityUsdt() });
  }

  ledger(): LedgerFill[] {
    return this.fills;
  }
  equityCurve(): EquityPoint[] {
    return this.curve;
  }
  finalEquity(): number {
    return this.equityUsdt();
  }

  // ---- internals ----
  private slip(side: 'BUY' | 'SELL', price: number): number {
    const s = this.cfg.slippageBps / 1e4;
    return side === 'BUY' ? price * (1 + s) : price * (1 - s);
  }

  private execMarket(m: DueMarket, refPrice: number): void {
    const px = this.slip(m.side, refPrice);
    let qty: number;
    if (m.qty !== null) qty = m.qty;
    else {
      const feeFrac = this.cfg.feeBps / 1e4; // size so notional + fee fits the quote budget
      qty = Number(floorQty(this.spec, (m.quoteQty ?? 0) / (px * (1 + feeFrac))));
    }
    if (qty <= 0) return;
    this.fill(m.id, m.side, px, qty, false); // market = taker
  }

  private tryCrossLimit(l: RestingLimit, bar: Bar): boolean {
    const crosses = l.side === 'BUY' ? bar.low <= l.price : bar.high >= l.price;
    if (!crosses) return false;
    this.fill(l.id, l.side, l.price, l.qty, true); // resting limit = maker
    return true;
  }

  private fill(orderId: string, side: 'BUY' | 'SELL', price: number, qty: number, isMaker: boolean): void {
    // long-only spot: never sell more than the held position (covers market + limit paths)
    if (side === 'SELL' && this.market === 'SPOT') qty = Math.min(qty, Math.max(this.pos.qty, 0));
    if (qty <= 0) return;
    const notional = price * qty;
    const fee = (notional * this.cfg.feeBps) / 1e4;
    if (side === 'BUY') {
      this.cash -= notional + fee;
      const cost = this.pos.avgEntry * this.pos.qty + notional;
      this.pos.qty += qty;
      this.pos.avgEntry = this.pos.qty > 0 ? cost / this.pos.qty : 0;
    } else {
      this.cash += notional - fee;
      this.pos.qty -= qty;
      if (this.pos.qty <= 1e-12) {
        this.pos.qty = 0;
        this.pos.avgEntry = 0;
      }
    }
    this.fills.push({ time: this.nowMs, side, price, qty, fee });
    this.fillCb?.({ orderId, side, price, qty, fee, feeAsset: this.spec.quoteAsset, isMaker, time: this.nowMs });
  }
}
