import type { MarketType, OrderSide } from "./market";

export type OrderType =
  | "MARKET"
  | "LIMIT"
  | "POST_ONLY"
  | "STOP_LOSS"
  | "STOP_LOSS_LIMIT"
  | "TAKE_PROFIT"
  | "TAKE_PROFIT_LIMIT";

export type OrderStatus =
  | "NEW"
  | "OPEN"
  | "PARTIAL"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED";

export type TimeInForce = "GTC" | "IOC" | "FOK";

export type ContingencyType = "OCO";
export type OrderListStatus = "EXECUTING" | "ALL_DONE" | "REJECTED";

// BE Order row JSON 그대로 (Decimal → string, DateTime → ISO string)
export interface Order {
  id: string;
  userId: string;
  tickerSymbol: string;
  tickerMarket: MarketType;
  type: OrderType;
  side: OrderSide;
  timeInForce: TimeInForce;
  price: string | null;
  stopPrice: string | null;
  origQty: string | null;
  origQuoteQty: string | null;
  executedQty: string;
  cumulativeQuoteQty: string;
  status: OrderStatus;
  triggeredAt: string | null;
  orderListId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderList {
  id: string;
  userId: string;
  tickerSymbol: string;
  tickerMarket: MarketType;
  side: OrderSide;
  contingencyType: ContingencyType;
  status: OrderListStatus;
  cancelRequested: boolean;
  stopPendingAt: string | null;
  lockAssetSymbol: string;
  lockAmount: string;
  createdAt: string;
  updatedAt: string;
  orders?: Order[];
}

export interface MyTrade {
  id: string;
  orderId: string;
  symbol: string;
  market: MarketType;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string | null;
  isBuyer: boolean;
  isMaker: boolean;
  time: number;
}

export interface Balance {
  asset: string;
  free: string;
  locked: string;
  ts?: number;
}

export interface CreateOrderReq {
  tickerSymbol: string;
  tickerMarket: "SPOT";
  type: OrderType;
  side: OrderSide;
  timeInForce: TimeInForce;
  price?: string;
  stopPrice?: string;
  origQty?: string;
  origQuoteQty?: string;
  replacesOrderId?: string;
}

export interface CreateOcoReq {
  tickerSymbol: string;
  tickerMarket: "SPOT";
  side: OrderSide;
  qty: string;
  price: string;
  stopPrice: string;
  stopLimitPrice: string;
  stopLimitTimeInForce: TimeInForce;
}

// user-stream 이벤트 — eq/cqq는 엔진 OU 메시지 값 (DB 아님)
export interface ExecutionReport {
  orderId: string;
  orderListId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  price?: string;
  stopPrice?: string;
  origQty?: string;
  origQuoteQty?: string;
  executedQty: string;
  cumulativeQuoteQty: string;
  status: OrderStatus;
  // per-fill 디테일 — 체결이 없던 리포트(NEW/CANCELED 등)에서는 생략(undefined)
  lastFilledQty?: string;
  lastFilledPrice?: string;
  commission?: string;
  commissionAsset?: string;
  tradeId?: string;
  ts: number;
}

export interface AccountPosition {
  balances: Balance[];
}

export interface ListStatusEvent {
  orderListId: string;
  symbol: string;
  status: OrderListStatus;
  orders: { orderId: string; status: OrderStatus }[];
  ts: number;
}

export interface Commission {
  makerBps: number;
  takerBps: number;
  maker: string;
  taker: string;
}
