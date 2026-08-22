export type Market = 'SPOT' | 'FUTURES';
export type Side = 'BUY' | 'SELL';

/** A single price level: [price, qty] as plain numbers (human units). */
export type Level = [number, number];

/** Top-of-book / partial-depth snapshot. */
export interface DepthSnapshot {
  bids: Level[]; // descending price
  asks: Level[]; // ascending price
}

/** Per-symbol precision pulled from the local exchange-info endpoint. */
export interface SymbolSpec {
  symbol: string;
  market: Market;
  pricePrecision: number; // decimals
  qtyPrecision: number; // decimals
  tickSize: number; // 10^-pricePrecision
  stepSize: number; // 10^-qtyPrecision
  minNotional: number; // min price*qty in quote
  baseAsset: string;
  quoteAsset: string;
}

export interface Balance {
  /** asset symbol (the local API uses `assetSymbol`). */
  asset: string;
  free: string;
  locked: string;
}

/** One OHLCV bar in human units. `isFinal=false` marks a still-forming bucket. */
export interface Bar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  isFinal: boolean;
}

/** The local exchange order envelope (subset we use). */
export interface LocalOrder {
  id: string;
  status: string;
  side?: Side;
  type?: string;
  tickerSymbol?: string;
  price: string | null;
  origQty: string | null;
  executedQty: string;
  cumulativeQuoteQty?: string;
}

/** One account fill (the local `/account/trades` row, subset). */
export interface AccountTrade {
  id: string;
  orderId: string;
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  isBuyer: boolean;
  isMaker: boolean;
  time: number; // epoch ms
}
