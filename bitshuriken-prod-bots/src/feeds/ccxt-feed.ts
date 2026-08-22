import ccxt from 'ccxt';
import type { AggTrade, DepthSnapshot, Feed, FeedSymbol, Level, Market } from '../types';
import { makeLogger, type Logger } from '../log';

type DepthCb = (symbol: string, depth: DepthSnapshot) => void;
type TradeCb = (symbol: string, trade: AggTrade) => void;

// WS is primary and normally used. On a transient WS failure (a venue briefly rate-limiting
// reconnects, a dropped socket) a symbol falls back to REST polling and periodically re-probes WS
// to restore the live stream. Depth is timeout-guarded (it should refresh continuously); trades are
// NOT — they are sporadic, so a quiet/low-volume market legitimately sends none for long stretches.
const WS_STALL_MS = 6000; // depth only: no book update this long = dead stream → fail
const WS_FAIL_LIMIT = 2; // consecutive WS failures before a symbol switches to REST polling
const REST_POLL_MS = 1500; // REST fallback cadence (courtesy to the external venue's rate limits)
const WS_REPROBE_EVERY = 40; // while on REST, retry WS every N polls (~60s) so a transient outage self-heals
const SUBSCRIBE_STAGGER_MS = 700; // gap between per-symbol WS subscribes — Upbit closes (code 1000) on rapid bursts

const toLevels = (l: [number, number][] | undefined): Level[] =>
  (l ?? [])
    .filter((x) => x[0] != null && x[1] != null)
    .map(([p, q]) => [Number(p), Number(q)] as Level);

type ProExchange = InstanceType<typeof ccxt.pro.binance>;

/**
 * Shared ccxt.pro WebSocket feed. Subclasses supply the exchange instance and the
 * local-symbol → ccxt-unified-symbol mapping. Keeps a synced order book so each
 * watchOrderBook read is a complete top-N snapshot the maker can mirror directly.
 */
export abstract class CcxtFeed implements Feed {
  protected readonly ex: ProExchange;
  private depthCb: DepthCb = () => {};
  private tradeCb: TradeCb = () => {};
  private stopped = false;
  protected readonly log: Logger;
  private readonly active = new Set<string>();
  private readonly gen = new Map<string, number>();
  private readonly byLocal = new Map<string, FeedSymbol>();
  private readonly lastTradeTs = new Map<string, number>(); // per-symbol trade cursor
  private readonly seenAtCursor = new Map<string, Set<string>>(); // trade ids AT the cursor ts (same-ms dedup)

  constructor(
    readonly market: Market,
    exchangeId: string,
    initial: FeedSymbol[],
    private levels: number,
  ) {
    // ccxt.pro is keyed by exchange id; both spot and USDⓈ-M live under pro.
    const ctor = (ccxt.pro as unknown as Record<string, new (o: object) => ProExchange>)[exchangeId];
    if (!ctor) throw new Error(`ccxt.pro has no exchange '${exchangeId}'`);
    this.ex = new ctor({ enableRateLimit: true });
    this.log = makeLogger(`${exchangeId}:${market.toLowerCase()}`);
    for (const s of initial) this.byLocal.set(s.symbol, s);
  }

  /** local symbol (e.g. BTCUSDT / BTCKRW) → ccxt unified symbol (e.g. BTC/USDT / BTC/KRW). */
  protected abstract unified(sym: FeedSymbol): string;

  /**
   * Next depth update for a unified symbol. Default: ccxt.pro's shared watch loop with NO
   * depth limit — a limit shrinks the seeding snapshot to that many levels, and as diffs
   * consume the near book the maintained tail turns sparse (stray far levels, e.g. a bid
   * parked at −10%, surface into the "top N"). Full-book subscribe keeps the top N
   * contiguous; consumers slice what they need.
   * Subclasses override when ccxt can't reach the venue's full depth (Upbit's ".30" codes).
   */
  protected watchDepth(u: string): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
    return this.ex.watchOrderBook(u) as unknown as Promise<{
      bids: [number, number][];
      asks: [number, number][];
    }>;
  }

  private u(symbol: string): string {
    const s = this.byLocal.get(symbol);
    if (!s) throw new Error(`unknown symbol ${symbol} (not registered with feed)`);
    return this.unified(s);
  }

  onDepth(cb: DepthCb): void {
    this.depthCb = cb;
  }
  onTrade(cb: TradeCb): void {
    this.tradeCb = cb;
  }

  /** one-shot REST order book (used by the parity checker). */
  async restDepth(symbol: string, limit: number): Promise<DepthSnapshot> {
    const ob = await this.ex.fetchOrderBook(this.u(symbol), limit);
    return {
      bids: toLevels(ob.bids as [number, number][]),
      asks: toLevels(ob.asks as [number, number][]),
    };
  }

  start(): void {
    void this.startStaggered();
  }

  // Subscribe one symbol at a time with a gap. Upbit closes the socket (code 1000) if it receives a
  // burst of rapid per-symbol re-subscribes on one connection; staggering avoids it. Harmless for
  // Binance (which multiplexes fine) — just a few seconds slower to fully stream at startup.
  private async startStaggered(): Promise<void> {
    for (const symbol of this.byLocal.keys()) {
      if (this.stopped) return;
      this.addSymbol(symbol);
      await this.sleep(SUBSCRIBE_STAGGER_MS);
    }
    this.log.ok(`streaming ${[...this.active].join(',') || '(none)'}`);
  }

  addSymbol(symbol: string): void {
    if (this.stopped) return;
    if (!this.byLocal.has(symbol)) return;
    const g = (this.gen.get(symbol) ?? 0) + 1;
    this.gen.set(symbol, g);
    if (this.active.has(symbol)) return;
    this.active.add(symbol);
    void this.streamDepth(symbol, g);
    void this.streamTrades(symbol, g);
  }

  /** register a symbol's base/quote mapping before addSymbol (used for runtime listing). */
  register(sym: FeedSymbol): void {
    this.byLocal.set(sym.symbol, sym);
  }

  removeSymbol(symbol: string): void {
    this.active.delete(symbol);
  }

  setLevels(levels: number): void {
    if (levels === this.levels) return;
    this.levels = levels;
    for (const symbol of [...this.active]) {
      this.removeSymbol(symbol);
      this.addSymbol(symbol);
    }
  }

  private live(symbol: string, g: number): boolean {
    return !this.stopped && this.active.has(symbol) && this.gen.get(symbol) === g;
  }

  private async streamDepth(symbol: string, g: number): Promise<void> {
    const u = this.u(symbol);
    let fails = 0;
    let rest = false;
    let restPolls = 0;
    while (this.live(symbol, g)) {
      try {
        // WS primary. While on REST, every WS_REPROBE_EVERY polls take the WS path instead — a
        // transient outage self-heals back to the live stream.
        let ob;
        if (rest && ++restPolls % WS_REPROBE_EVERY !== 0) {
          ob = await this.ex.fetchOrderBook(u, this.levels);
        } else {
          ob = await this.withTimeout(this.watchDepth(u), WS_STALL_MS, `depth ${symbol}`);
          if (rest) {
            rest = false;
            this.log.ok(`depth ${symbol}: WebSocket restored`);
          }
          fails = 0;
        }
        if (!this.live(symbol, g)) return;
        this.depthCb(symbol, {
          bids: toLevels(ob.bids as [number, number][]).slice(0, this.levels),
          asks: toLevels(ob.asks as [number, number][]).slice(0, this.levels),
        });
        if (rest) await this.sleep(REST_POLL_MS);
      } catch (e) {
        if (!this.live(symbol, g)) return;
        if (this.dropIfUnlisted(symbol, e)) return;
        if (!rest && ++fails >= WS_FAIL_LIMIT) {
          rest = true;
          restPolls = 0;
          this.log.warn(`depth ${symbol}: WebSocket unavailable → REST polling`, (e as Error).message);
        } else {
          await this.sleep(rest ? REST_POLL_MS : 1000);
        }
      }
    }
  }

  // A symbol the source venue doesn't list can never stream — retrying forever is a silent
  // hot loop against the external API (exotic local listings hit this). Drop it for good.
  private dropIfUnlisted(symbol: string, e: unknown): boolean {
    if (!(e instanceof ccxt.BadSymbol)) return false;
    this.log.err(`${symbol}: not listed on the source venue — mirroring disabled (${(e as Error).message})`);
    this.removeSymbol(symbol);
    return true;
  }

  private async streamTrades(symbol: string, g: number): Promise<void> {
    const u = this.u(symbol);
    let fails = 0;
    let rest = false;
    let restPolls = 0;
    while (this.live(symbol, g)) {
      try {
        if (rest && ++restPolls % WS_REPROBE_EVERY !== 0) {
          // emitTrades swallows the first (unprimed) batch as the baseline, so an unset cursor here
          // just means the first poll's history is used to prime instead of being replayed.
          const trades = await this.ex.fetchTrades(u, this.lastTradeTs.get(symbol), 50);
          if (!this.live(symbol, g)) return;
          this.emitTrades(symbol, trades);
          await this.sleep(REST_POLL_MS);
        } else {
          // NO stall-timeout: trades are sporadic, so a quiet market yields none for long stretches
          // — that is not a failure. ccxt.pro throws on an actually dead socket (its own keepalive).
          // Reaching this branch from REST (the WS_REPROBE_EVERY tick) also restores the live stream.
          const trades = await this.ex.watchTrades(u);
          if (!this.live(symbol, g)) return;
          if (rest) {
            rest = false;
            this.log.ok(`trades ${symbol}: WebSocket restored`);
          }
          fails = 0;
          this.emitTrades(symbol, trades);
        }
      } catch (e) {
        if (!this.live(symbol, g)) return;
        if (this.dropIfUnlisted(symbol, e)) return;
        if (!rest && ++fails >= WS_FAIL_LIMIT) {
          rest = true;
          restPolls = 0;
          this.log.warn(`trades ${symbol}: WebSocket unavailable → REST polling`, (e as Error).message);
        } else {
          await this.sleep(rest ? REST_POLL_MS : 1000);
        }
      }
    }
  }

  // Emit only trades past the per-symbol cursor (REST poll windows overlap; WS first-resolve
  // includes ccxt's cached history). Cursor = (ts, ids-at-ts): active symbols print several
  // trades in the SAME millisecond, so a ts-only cursor would systematically drop the
  // same-ms trades that straddle a batch boundary — ids at the cursor ts disambiguate.
  // The very first batch per symbol is swallowed whole as the baseline ("mirror from now on"),
  // which also keeps the WS path from replaying pre-boot history.
  private emitTrades(
    symbol: string,
    trades: { id?: string; timestamp?: number; price?: number; amount?: number; side?: string }[],
  ): void {
    const tradeKey = (t: (typeof trades)[0]): string => t.id ?? `${t.price}/${t.amount}/${t.side}`;
    const primed = this.lastTradeTs.has(symbol);
    const last = this.lastTradeTs.get(symbol) ?? 0;
    let maxTs = last;
    for (const t of trades) if ((t.timestamp ?? 0) > maxTs) maxTs = t.timestamp ?? 0;

    if (!primed) {
      this.lastTradeTs.set(symbol, maxTs || Date.now());
      this.seenAtCursor.set(symbol, new Set(trades.filter((t) => t.timestamp === maxTs).map(tradeKey)));
      return;
    }

    const seen = this.seenAtCursor.get(symbol) ?? new Set<string>();
    const atNewCursor = new Set<string>();
    for (const t of trades) {
      const ts = t.timestamp ?? 0;
      if (ts === maxTs) atNewCursor.add(tradeKey(t));
      if (ts < last || (ts === last && seen.has(tradeKey(t)))) continue;
      if (t.price == null || t.amount == null) continue;
      this.tradeCb(symbol, {
        price: Number(t.price),
        qty: Number(t.amount),
        buyerIsMaker: t.side === 'sell', // taker sold → buyer was the maker
      });
    }
    if (maxTs > last) {
      this.lastTradeTs.set(symbol, maxTs);
      this.seenAtCursor.set(symbol, atNewCursor);
    } else {
      for (const k of atNewCursor) seen.add(k);
      this.seenAtCursor.set(symbol, seen);
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} stalled >${ms}ms`)), ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  stop(): void {
    this.stopped = true;
    void this.ex.close();
  }
}
