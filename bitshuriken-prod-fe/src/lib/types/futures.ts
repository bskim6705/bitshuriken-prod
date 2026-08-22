import type { MarketType, OrderSide } from "./market";
import type { Order, OrderStatus, OrderType, TimeInForce } from "./trading";

// stop류는 mark price 트리거까지 BE 보관 후 underlying으로 엔진 전송
export type FuturesOrderType =
  | "MARKET"
  | "LIMIT"
  | "POST_ONLY"
  | "STOP_LOSS"
  | "STOP_LOSS_LIMIT"
  | "TAKE_PROFIT"
  | "TAKE_PROFIT_LIMIT";

export type PositionStatus = "NORMAL" | "LIQUIDATING";

export type MarginMode = "ISOLATED" | "CROSS";

export type FuturesIncomeType =
  | "REALIZED_PNL"
  | "COMMISSION"
  | "FUNDING_FEE"
  | "LIQUIDATION_FEE"
  | "TRANSFER"
  | "INSURANCE_CLEAR";

// BE Order row JSON 그대로 — futures 전용 필드 포함
export interface FuturesOrder extends Order {
  reduceOnly: boolean;
  liquidation: boolean;
  lockedCost: string | null;
}

// GET /futures/account/positions — 파생 필드는 mark 미형성/qty==0이면 null.
// marginRatio null + qty≠0 + mark 존재 = equity ≤ 0 (즉시 청산 대상)
export interface Position {
  symbol: string;
  qty: string; // signed: + long, − short
  entryPrice: string;
  isolatedMargin: string;
  leverage: number;
  marginMode: MarginMode;
  status: PositionStatus;
  markPrice: string | null;
  unrealizedPnl: string | null;
  // CROSS는 계정 단위 — 같은 유저의 모든 cross 포지션이 동일 marginRatio, liquidationPrice는 추정가
  liquidationPrice: string | null;
  marginRatio: string | null;
  updatedAt: string;
}

// PATCH /futures/trading/positions/:symbol 응답 — raw Position row (파생 필드 없음)
export interface PositionRow {
  userId: string;
  tickerSymbol: string;
  tickerMarket: MarketType;
  qty: string;
  entryPrice: string;
  isolatedMargin: string;
  leverage: number;
  marginMode: MarginMode;
  status: PositionStatus;
  updatedAt: string;
}

// REST는 wallet row 매핑, fuser outboundAccountPosition은 이 형태 그대로
export interface FuturesBalance {
  asset: string;
  free: string;
  locked: string;
  ts: number;
}

// GET /futures/market/mark-price + {sym}@markPrice 스트림.
// REST는 index 미형성 시 mark/index null, 스트림은 형성 후에만 push
export interface MarkPrice {
  symbol: string;
  markPrice: string | null;
  indexPrice: string | null;
  lastFundingRate: string | null;
  nextFundingTime: number;
}

export interface FundingRate {
  symbol: string;
  fundingTime: number;
  rate: string;
  markPrice: string;
}

// GET /futures/account/income — FuturesIncome row JSON 그대로
export interface FuturesIncome {
  id: string;
  userId: string;
  tickerSymbol: string | null; // TRANSFER 등 심볼 무관 항목은 null
  incomeType: FuturesIncomeType;
  income: string; // signed
  sourceKey: string;
  createdAt: string;
}

// GET /futures/market/exchange-info — 심볼 메타 + 심볼별 정책(maxLeverage)
export interface FuturesSymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  qtyPrecision: number;
  tickSize: string;
  stepSize: string;
  minNotional: string;
  maxLeverage: number;
}

export interface FuturesExchangeInfo {
  serverTime: number;
  klineIntervals: string[];
  symbols: FuturesSymbolInfo[];
}

// GET /futures/market/recent-trades — raw row (spot WsTrade와 필드명 다름)
export interface FuturesRecentTrade {
  id: string;
  tickerSymbol: string;
  tickerMarket: MarketType;
  takerSide: OrderSide;
  price: string;
  qty: string;
  createdAt: string;
}

export interface CreateFuturesOrderReq {
  symbol: string;
  type: FuturesOrderType;
  side: OrderSide;
  // LIMIT/*_LIMIT 필수. MARKET·STOP_LOSS·TAKE_PROFIT=IOC, POST_ONLY=GTC 고정 (생략 가능)
  timeInForce?: TimeInForce;
  price?: string;
  // stop류 트리거 가격 (mark 기준). STOP/TP 계열 필수
  stopPrice?: string;
  qty: string;
  reduceOnly?: boolean;
}

// {leverage} XOR {marginDelta} XOR {marginMode} — 동시 전송은 BE가 거부
export type UpdatePositionReq =
  | { leverage: number }
  | { marginDelta: string }
  | { marginMode: MarginMode };

export interface TransferReq {
  fromMarket: MarketType;
  toMarket: MarketType;
  assetSymbol: string;
  qty: string;
}

export interface TransferRes {
  transferId: string;
  fromMarket: MarketType;
  toMarket: MarketType;
  assetSymbol: string;
  qty: string;
}

// ---- /ws/fuser 이벤트 ----

export type FuturesUserStreamName =
  | "executionReport"
  | "outboundAccountPosition"
  | "positionUpdate"
  | "MARGIN_CALL";

// eq/cqq는 엔진 OU 메시지 값 (DB 아님) — spot ExecutionReport와 동일 의미론
export interface FuturesExecutionReport {
  orderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  price?: string;
  origQty?: string;
  executedQty: string;
  cumulativeQuoteQty: string;
  status: OrderStatus;
  reduceOnly: boolean;
  // per-fill 디테일 — 체결이 없던 리포트에서는 null. realizedPnl은 futures 전용
  lastFilledQty: string | null;
  lastFilledPrice: string | null;
  commission: string | null;
  commissionAsset: string | null;
  tradeId: string | null;
  realizedPnl: string | null;
  ts: number;
}

// 청산 사전 경고 — 경제적 효과 없는 알림 전용
export interface MarginCallEvent {
  symbol: string;
  marginMode: MarginMode;
  marginRatio: string;
  markPrice: string;
  ts: number;
}

export interface FuturesAccountPosition {
  balances: FuturesBalance[];
}

// ts = Position.updatedAt epoch ms — 심볼별 max(ts)로 stale drop
export interface FuturesPositionSnapshot {
  symbol: string;
  qty: string;
  entryPrice: string;
  isolatedMargin: string;
  leverage: number;
  marginMode: MarginMode;
  status: PositionStatus;
  // mark 형성 시 채움, 미형성 시 null. liquidationPrice는 ISOLATED만 — CROSS는 계정 의존이라 null (FE가 REST 보충)
  markPrice: string | null;
  unrealizedPnl: string | null;
  liquidationPrice: string | null;
  ts: number;
}

export interface FuturesPositionUpdate {
  positions: FuturesPositionSnapshot[];
}
