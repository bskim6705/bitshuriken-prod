export type Side = 'BUY' | 'SELL';

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

/** Per-symbol precision (local exchange-info or Binance market metadata). */
export interface SymbolSpec {
  symbol: string;
  pricePrecision: number;
  qtyPrecision: number;
  tickSize: number;
  stepSize: number;
  minNotional: number;
  baseAsset: string;
  quoteAsset: string;
}

/** One realized fill (sim ledger or /account/trades). */
export interface Fill {
  time: number;
  side: Side;
  price: number;
  qty: number;
  fee: number; // quote
}

export interface EquityPoint {
  t: number;
  equity: number;
}
