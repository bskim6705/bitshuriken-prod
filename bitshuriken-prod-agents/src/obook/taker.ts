import { depth } from '../core/exchange';
import type { SubaccountClient } from '../core/exchange';
import { floorQty, meetsMinNotional, roundPrice } from '../core/precision';
import { makeLogger } from '../core/logger';
import { rsi } from '../indicators/rsi';
import { ema } from '../indicators/ma';
import type { Balance, DepthSnapshot, SymbolSpec } from '../core/types';

// Entry signals (all long-only spot):
//   imbalance — order-book bid/ask ratio (momentum)      meanrev  — mid below its rolling EMA
//   rsi       — fast Wilder RSI on the live mid series     emacross — fast EMA over slow EMA
//   momentum  — mid rate-of-change over the last N ticks
// TA signals run on a real-time mid buffer sampled every poll (not candles) — aggressive/intraday.
export type ScalpSignal = 'imbalance' | 'meanrev' | 'rsi' | 'emacross' | 'momentum';

export interface ObookOpts {
  signal: ScalpSignal;
  quotePerTrade: number; // position notional in quote units
  enterImb: number; // (imbalance) book imbalance to open a long (0..1)
  exitImb: number; // (imbalance) imbalance to give up a long even before TP/SL
  mrDipBps: number; // (meanrev) enter when mid is this many bps below its rolling mean
  mrWindow: number; // (meanrev) EMA window (ticks) for the rolling mean of mid
  rsiPeriod: number; // (rsi) lookback in ticks
  rsiBuy: number; // (rsi) enter long when RSI ≤ this (oversold)
  rsiSell: number; // (rsi) exit when RSI ≥ this (overbought)
  emaFast: number; // (emacross) fast EMA window in ticks
  emaSlow: number; // (emacross) slow EMA window in ticks
  momTicks: number; // (momentum) rate-of-change lookback in ticks
  momBps: number; // (momentum) enter when ROC ≥ this many bps (exit on ≤ −this)
  tpBps: number; // take-profit, bps of entry mid
  slBps: number; // stop-loss, bps of entry mid
  depthLevels: number; // L2 levels summed into the imbalance signal
  pollMs: number;
  takerBps: number;
}

interface Book {
  bid: number;
  ask: number;
  bidSz: number; // touch bid size
  askSz: number; // touch ask size
  mid: number;
  imb: number; // (Σbid − Σask)/(Σbid + Σask) over depthLevels, in [-1, 1]
}

// Async settlement: an order response carries NO fill (order → Kafka → match → settle). Position is
// therefore read from balances (the truth), and a per-symbol `pending` flag suppresses re-entry
// during the settlement lag so a fast re-decision loop can't stack duplicate orders.
type Pending = null | 'buy' | 'sell';
interface State {
  entry: number; // avg entry recorded when the buy was placed
  pending: Pending;
  pendingTicks: number;
  ema: number; // rolling mean of mid (meanrev signal); 0 = unseeded
  mids: number[]; // live mid buffer feeding the TA signals (rsi / emacross / momentum)
}
const MIDBUF = 240; // capped mid history — enough for the slow EMA / RSI to converge
const PENDING_TIMEOUT = 6; // ticks to wait for a placed order to show in balances before retrying

function readBook(d: DepthSnapshot, levels: number): Book | null {
  const b = d.bids[0];
  const a = d.asks[0];
  if (!b || !a) return null;
  const sum = (l: [number, number][]): number => l.slice(0, levels).reduce((s, x) => s + x[1], 0);
  const sb = sum(d.bids);
  const sa = sum(d.asks);
  const imb = sb + sa > 0 ? (sb - sa) / (sb + sa) : 0;
  return { bid: b[0], ask: a[0], bidSz: b[1], askSz: a[1], mid: (b[0] + a[0]) / 2, imb };
}

/**
 * Order-book-only taker. No candles, no indicators — it reads the live L2 book, opens a long when
 * bid-side imbalance signals upward pressure, and takes profit / stops / bails when the signal
 * fades. Entries and exits are marketable-limit IOC at the touch. One position per symbol; position
 * is tracked from balances (async settlement), gated by a pending flag to prevent duplicate orders.
 */
export class ObookTaker {
  private readonly log = makeLogger('obook');
  private stopped = false;
  private ticks = 0;
  private readonly st = new Map<string, State>();
  private trades = 0;
  private readonly realized = new Map<string, number>(); // indicative realized quote PnL per symbol

  constructor(
    private readonly client: SubaccountClient,
    private readonly specs: SymbolSpec[],
    private readonly opts: ObookOpts,
  ) {}

  async run(): Promise<void> {
    this.log.ok(
      `signal=${this.opts.signal} tp=${this.opts.tpBps}bps sl=${this.opts.slBps}bps ` +
        `size≈${this.opts.quotePerTrade}/trade poll=${this.opts.pollMs}ms symbols=${this.specs.map((s) => s.symbol).join(',')}`,
    );
    while (!this.stopped) {
      try {
        const held = await this.baseAmounts();
        await Promise.all(this.specs.map((s) => this.step(s, held.get(s.baseAsset) ?? 0)));
      } catch (e) {
        this.log.warn('tick failed', (e as Error).message);
      }
      this.ticks++;
      await this.sleep(this.opts.pollMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  stats(): { ticks: number; trades: number; realizedQuote: number } {
    let realizedQuote = 0;
    for (const v of this.realized.values()) realizedQuote += v;
    return { ticks: this.ticks, trades: this.trades, realizedQuote };
  }

  /** free+locked base balance per asset — the source of truth for open positions. */
  private async baseAmounts(): Promise<Map<string, number>> {
    const bals: Balance[] = await this.client.balances('SPOT');
    const m = new Map<string, number>();
    for (const b of bals) m.set(b.asset, (m.get(b.asset) ?? 0) + Number(b.free) + Number(b.locked));
    return m;
  }

  private state(sym: string): State {
    let s = this.st.get(sym);
    if (!s) {
      s = { entry: 0, pending: null, pendingTicks: 0, ema: 0, mids: [] };
      this.st.set(sym, s);
    }
    return s;
  }

  private async step(spec: SymbolSpec, baseAmt: number): Promise<void> {
    const book = readBook(await depth('SPOT', spec.symbol, Math.max(5, this.opts.depthLevels)), this.opts.depthLevels);
    if (!book) return;
    const s = this.state(spec.symbol);
    const dust = spec.stepSize;

    // reconcile a placed order against settled balances before deciding anything new.
    if (s.pending === 'buy') {
      if (baseAmt > dust) {
        s.pending = null;
        s.pendingTicks = 0;
      } else if (++s.pendingTicks > PENDING_TIMEOUT) {
        s.pending = null; // IOC didn't fill (no cross) — allow a fresh attempt
        s.pendingTicks = 0;
      } else return;
    } else if (s.pending === 'sell') {
      if (baseAmt <= dust) {
        s.pending = null;
        s.pendingTicks = 0;
      } else if (++s.pendingTicks > PENDING_TIMEOUT) {
        s.pending = null; // partial/again next tick
        s.pendingTicks = 0;
      } else return;
    }

    // maintain the state the signals read: a live mid buffer (TA) + an incremental EMA (meanrev).
    s.mids.push(book.mid);
    if (s.mids.length > MIDBUF) s.mids.shift();
    const alpha = 2 / (this.opts.mrWindow + 1);
    s.ema = s.ema > 0 ? s.ema + alpha * (book.mid - s.ema) : book.mid;

    const sig = this.signal(s, book);
    if (baseAmt <= dust) {
      if (sig.enter) await this.enter(spec, book, s);
      return;
    }
    // holding a long — manage the exit
    if (s.entry <= 0) s.entry = book.mid; // resync safety (shouldn't happen: funded quote-only)
    const pnlBps = ((book.mid - s.entry) / s.entry) * 10_000;
    const why = pnlBps >= this.opts.tpBps ? 'tp' : pnlBps <= -this.opts.slBps ? 'sl' : sig.exitSig ? sig.label : null;
    if (why) await this.exit(spec, book, s, baseAmt, why);
  }

  /** the active entry/exit signal off the current book + rolling state. Long-only. */
  private signal(s: State, book: Book): { enter: boolean; exitSig: boolean; label: string } {
    const o = this.opts;
    switch (o.signal) {
      case 'imbalance':
        return { enter: book.imb >= o.enterImb, exitSig: book.imb <= o.exitImb, label: 'fade' };
      case 'meanrev':
        return { enter: book.mid <= s.ema * (1 - o.mrDipBps / 1e4), exitSig: book.mid >= s.ema, label: 'revert' };
      case 'rsi': {
        const r = rsi(s.mids, o.rsiPeriod);
        return { enter: r <= o.rsiBuy, exitSig: r >= o.rsiSell, label: 'rsi' };
      }
      case 'emacross': {
        const f = ema(s.mids, o.emaFast);
        const sl = ema(s.mids, o.emaSlow);
        return { enter: f > sl, exitSig: f < sl, label: 'xdown' };
      }
      case 'momentum': {
        const roc = this.rocBps(s.mids, o.momTicks);
        return { enter: roc >= o.momBps, exitSig: roc <= -o.momBps, label: 'momrev' };
      }
    }
  }

  /** rate-of-change over the last n ticks, in bps (0 until the buffer is long enough). */
  private rocBps(mids: number[], n: number): number {
    if (mids.length <= n) return 0;
    const past = mids[mids.length - 1 - n]!;
    const now = mids[mids.length - 1]!;
    return past > 0 ? (now / past - 1) * 10_000 : 0;
  }

  private async enter(spec: SymbolSpec, book: Book, s: State): Promise<void> {
    const qty = floorQty(spec, Math.min(this.opts.quotePerTrade / book.ask, book.askSz)); // cap to touch → fill at ask
    if (Number(qty) <= 0 || !meetsMinNotional(spec, book.ask, Number(qty))) return;
    const ok = await this.client
      .placeLimitIoc(spec, 'BUY', roundPrice(spec, book.ask), qty)
      .then(() => true)
      .catch((e) => {
        this.log.warn(`${spec.symbol} enter rejected`, (e as Error).message);
        return false;
      });
    if (!ok) return;
    s.pending = 'buy';
    s.pendingTicks = 0;
    s.entry = book.ask;
    this.trades++;
    this.log.ok(`${spec.symbol} BUY ${qty}@${book.ask.toFixed(spec.pricePrecision)} imb=${book.imb.toFixed(2)} (placed)`);
  }

  private async exit(spec: SymbolSpec, book: Book, s: State, baseAmt: number, why: string): Promise<void> {
    const qty = floorQty(spec, baseAmt);
    if (Number(qty) <= 0) return;
    const ok = await this.client
      .placeLimitIoc(spec, 'SELL', roundPrice(spec, book.bid), qty)
      .then(() => true)
      .catch((e) => {
        this.log.warn(`${spec.symbol} exit rejected`, (e as Error).message);
        return false;
      });
    if (!ok) return;
    // indicative realized: fill ≈ touch bid, both legs' taker fee. Truth is settled balances at stop.
    const fee = (this.opts.takerBps / 10_000) * Number(qty) * (book.bid + s.entry);
    const pnl = Number(qty) * (book.bid - s.entry) - fee;
    this.realized.set(spec.symbol, (this.realized.get(spec.symbol) ?? 0) + pnl);
    s.pending = 'sell';
    s.pendingTicks = 0;
    this.trades++;
    this.log.ok(`${spec.symbol} SELL(${why}) ${qty}@${book.bid.toFixed(spec.pricePrecision)} pnl≈${pnl.toFixed(2)} (placed)`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
