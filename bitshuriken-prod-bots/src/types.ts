export type Market = 'SPOT' | 'FUTURES';
export type Side = 'BUY' | 'SELL';

/** Which external exchange a ticker mirrors. Routed by quote asset: USDT/USDC → Binance, KRW → Upbit. */
export type MirrorSource = 'BINANCE' | 'UPBIT';

/** A single price level: [price, qty] as plain numbers (already in human units). */
export type Level = [number, number];

/** Top-of-book snapshot from a partial-depth stream or a REST snapshot. */
export interface DepthSnapshot {
  bids: Level[]; // descending price
  asks: Level[]; // ascending price
  lastUpdateId?: number; // 로컬 거래소 REST 스냅샷만 — diff 스트림 동기화 기준점
}

/** An aggregate trade (the leg we replay locally). */
export interface AggTrade {
  price: number;
  qty: number;
  /** true when the buyer is the maker → the trade was a SELL taker. */
  buyerIsMaker: boolean;
}

/** Per-symbol precision pulled from the local exchange-info endpoint. */
export interface SymbolSpec {
  symbol: string;
  market: Market;
  pricePrecision: number; // decimals
  qtyPrecision: number; // decimals
  tickSize: number; // flat tick (KRW markets are tiered — see krw-ticks.ts)
  stepSize: number; // 10^-qtyPrecision
  minNotional: number; // min price*qty in quote
  baseAsset: string;
  quoteAsset: string;
}

/** Mirror source for a spec (by quote asset). */
export function sourceOf(spec: SymbolSpec): MirrorSource {
  return spec.quoteAsset === 'KRW' ? 'UPBIT' : 'BINANCE';
}

export interface Balance {
  asset: string;
  free: string;
  locked: string;
}

/** The local exchange order envelope (subset we use). */
export interface LocalOrder {
  id: string;
  status: string;
  side: Side;
  price: string | null;
  origQty: string | null;
  executedQty: string;
}

type DepthCb = (symbol: string, depth: DepthSnapshot) => void;
type TradeCb = (symbol: string, trade: AggTrade) => void;

/** A public market-data feed for one external exchange + market. Binance and Upbit both implement it. */
export interface Feed {
  readonly market: Market;
  onDepth(cb: DepthCb): void;
  onTrade(cb: TradeCb): void;
  restDepth(symbol: string, limit: number): Promise<DepthSnapshot>;
  start(): void;
  addSymbol(symbol: string): void;
  removeSymbol(symbol: string): void;
  setLevels(levels: number): void;
  stop(): void;
}

/** What a feed needs to map a local symbol to the exchange's unified symbol. */
export interface FeedSymbol {
  symbol: string; // local symbol, e.g. BTCUSDT / BTCKRW
  baseAsset: string; // BTC
  quoteAsset: string; // USDT / KRW
}
