import ccxt from 'ccxt';
import type { AggTrade, DepthSnapshot, Feed, FeedSymbol, Level, Market } from '../types';
import { makeLogger, type Logger } from '../log';

type DepthCb = (symbol: string, depth: DepthSnapshot) => void;
type TradeCb = (symbol: string, trade: AggTrade) => void;

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
    for (const symbol of this.byLocal.keys()) this.addSymbol(symbol);
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
    while (this.live(symbol, g)) {
      try {
        const ob = await this.ex.watchOrderBook(u, this.levels);
        if (!this.live(symbol, g)) return;
        this.depthCb(symbol, {
          bids: toLevels(ob.bids as [number, number][]),
          asks: toLevels(ob.asks as [number, number][]),
        });
      } catch (e) {
        if (!this.live(symbol, g)) return;
        this.log.warn(`depth ${symbol}`, (e as Error).message);
        await this.sleep(1000);
      }
    }
  }

  private async streamTrades(symbol: string, g: number): Promise<void> {
    const u = this.u(symbol);
    while (this.live(symbol, g)) {
      try {
        const trades = await this.ex.watchTrades(u);
        if (!this.live(symbol, g)) return;
        for (const t of trades) {
          this.tradeCb(symbol, {
            price: Number(t.price),
            qty: Number(t.amount),
            buyerIsMaker: t.side === 'sell', // taker sold → buyer was the maker
          });
        }
      } catch (e) {
        if (!this.live(symbol, g)) return;
        this.log.warn(`trades ${symbol}`, (e as Error).message);
        await this.sleep(1000);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  stop(): void {
    this.stopped = true;
    void this.ex.close();
  }
}
