export type MarketType = "SPOT" | "FUTURES";
export type OrderSide = "BUY" | "SELL";

export interface Ticker24h {
  symbol: string;
  marketType: MarketType;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  qtyPrecision: number;
  lastPrice: string | null;
  open24h: string | null;
  priceChange24h: string | null;
  priceChangePct24h: string | null;
  high24h: string | null;
  low24h: string | null;
  volume24h: string;
  quoteVolume24h: string;
  tradeCount24h: number;
}

export interface Kline {
  symbol: string;
  interval: string;
  openTime: number;
  closeTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quoteVolume: string;
  tradeCount: number;
  isFinal: boolean;
}

export interface BookTicker {
  symbol: string;
  bidPrice: string | null;
  bidQty: string | null;
  askPrice: string | null;
  askQty: string | null;
  lastUpdateId: number;
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  qtyPrecision: number;
  tickSize: string;
  stepSize: string;
  minNotional: string;
  ocoAllowed: boolean;
}

export interface ExchangeInfo {
  serverTime: number;
  klineIntervals: string[];
  orderTypes: string[];
  timeInForce: string[];
  symbols: SymbolInfo[];
}

export interface DepthSnapshot {
  lastUpdateId: number;
  bids: [string, string][]; // [price, qty]
  asks: [string, string][];
}

export interface WsTrade {
  id: string;
  symbol: string;
  price: string;
  qty: string;
  side: OrderSide;
  ts: number;
}
