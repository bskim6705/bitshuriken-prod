import WebSocket from 'ws';
import type { FeedSymbol, Market } from '../types';
import { CcxtFeed } from './ccxt-feed';

const UPBIT_WS = 'wss://api.upbit.com/websocket/v1';
// Upbit WS depth: a plain code ("KRW-BTC") streams 15 levels/side; the ".30" suffix streams the
// venue max of 30. ccxt.pro has no hook for the suffix, so depth uses a dedicated socket here
// (trades stay on the ccxt socket). Every orderbook message is a full top-30 snapshot.
const UPBIT_DEPTH_UNITS = 30;
// Upbit closes idle sockets (~2min). Ping frames keep the dedicated depth socket alive through
// quiet stretches instead of paying a reconnect gap (code-1000 close) every time.
const PING_EVERY_MS = 30_000;

interface RawBook {
  bids: [number, number][];
  asks: [number, number][];
}
interface Waiter {
  resolve: (b: RawBook) => void;
  reject: (e: Error) => void;
}
interface OrderbookMsg {
  type: string;
  code: string;
  orderbook_units: { bid_price: number; bid_size: number; ask_price: number; ask_size: number }[];
}

/**
 * Public Upbit market-data feed. Trades via ccxt.pro; depth via a raw ".30" WebSocket
 * subscription (see UPBIT_DEPTH_UNITS). Upbit is spot-only and KRW-quoted.
 */
export class UpbitFeed extends CcxtFeed {
  private ws: WebSocket | null = null;
  private wsOpen: Promise<void> | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly codes = new Set<string>(); // subscribed plain market codes (KRW-BTC)
  // code → the ONE watcher for the next update. A single stream loop watches each symbol, so a
  // second waiter for a code means the first was abandoned by its caller's stall timeout —
  // holding a queue would leak one entry per timeout on a quiet/broken code.
  private readonly waiters = new Map<string, Waiter>();
  private feedStopped = false;

  constructor(market: Market, initial: FeedSymbol[], levels: number) {
    if (market !== 'SPOT') throw new Error('Upbit mirrors spot only (no perps)');
    super(market, 'upbit', initial, levels);
  }

  // BTCKRW → BTC/KRW ; USDTKRW → USDT/KRW.
  protected unified(sym: FeedSymbol): string {
    return `${sym.baseAsset}/${sym.quoteAsset}`;
  }

  /** resolves with the next full top-30 snapshot for this symbol. */
  protected override async watchDepth(u: string): Promise<RawBook> {
    const code = toCode(u);
    const isNew = !this.codes.has(code);
    if (isNew) this.codes.add(code);
    // a socket still CONNECTING picks new codes up in its open-handler subscribe; only an
    // already-open socket needs a fresh send (Upbit replaces the whole list per send).
    const needSend = isNew && this.ws?.readyState === WebSocket.OPEN;
    await this.ensureSocket();
    if (needSend) this.subscribe();
    return new Promise<RawBook>((resolve, reject) => {
      this.waiters.get(code)?.reject(new Error(`superseded watcher (${code})`));
      this.waiters.set(code, { resolve, reject });
    });
  }

  private ensureSocket(): Promise<void> {
    if (this.feedStopped) return Promise.reject(new Error('feed stopped'));
    if (this.wsOpen) return this.wsOpen;
    const ws = new WebSocket(UPBIT_WS);
    this.ws = ws;
    this.wsOpen = new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        this.subscribe();
        this.pingTimer = setInterval(() => ws.ping(), PING_EVERY_MS);
        resolve();
      });
      ws.on('message', (d) => this.onMessage(d.toString()));
      ws.on('error', (e) => {
        this.dropSocket(ws, e instanceof Error ? e : new Error(String(e)));
        reject(e instanceof Error ? e : new Error(String(e)));
      });
      ws.on('close', (codeNum) => {
        this.dropSocket(ws, new Error(`upbit depth ws closed (${codeNum})`));
        reject(new Error(`upbit depth ws closed (${codeNum})`));
      });
    });
    // a rejected open must not stick as the cached promise (next watchDepth reconnects)
    this.wsOpen.catch(() => {});
    return this.wsOpen;
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.codes.size === 0) return;
    const codes = [...this.codes].map((c) => `${c}.${UPBIT_DEPTH_UNITS}`);
    this.ws.send(JSON.stringify([{ ticket: 'bs-depth' }, { type: 'orderbook', codes }]));
  }

  private onMessage(raw: string): void {
    let msg: OrderbookMsg;
    try {
      msg = JSON.parse(raw) as OrderbookMsg;
    } catch {
      return;
    }
    if (msg.type !== 'orderbook' || !Array.isArray(msg.orderbook_units)) return;
    const book: RawBook = {
      bids: msg.orderbook_units.map((u) => [u.bid_price, u.bid_size]),
      asks: msg.orderbook_units.map((u) => [u.ask_price, u.ask_size]),
    };
    const w = this.waiters.get(msg.code);
    if (!w) return;
    this.waiters.delete(msg.code);
    w.resolve(book);
  }

  /** tear down a dead socket and fail its pending watchers (their loops retry / fall to REST). */
  private dropSocket(ws: WebSocket, err: Error): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.wsOpen = null;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    const pending = [...this.waiters.values()];
    this.waiters.clear();
    for (const w of pending) w.reject(err);
  }

  override stop(): void {
    this.feedStopped = true;
    const ws = this.ws;
    if (ws) this.dropSocket(ws, new Error('feed stopped'));
    ws?.close();
    super.stop();
  }
}

/** ccxt unified "BTC/KRW" → Upbit market code "KRW-BTC". */
function toCode(u: string): string {
  const [base, quote] = u.split('/');
  return `${quote}-${base}`;
}
