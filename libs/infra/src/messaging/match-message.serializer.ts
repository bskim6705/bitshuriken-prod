import { MarketType, Order, OrderSide, OrderType, TimeInForce } from '@prisma/client';
import { isMarketLike } from '@app/shared/order-classify';
import { toScaledIntString } from '@app/shared/decimal';
import { Op, OpCode } from './topics';

// stop 계열은 트리거 후 underlying 타입으로 엔진에 전송된다.
const TYPE_CODE: Record<OrderType, string> = {
  LIMIT: 'L',
  MARKET: 'M',
  POST_ONLY: 'PO',
  STOP_LOSS: 'M',
  TAKE_PROFIT: 'M',
  STOP_LOSS_LIMIT: 'L',
  TAKE_PROFIT_LIMIT: 'L',
};

const SIDE_CODE: Record<OrderSide, string> = {
  BUY: 'B',
  SELL: 'S',
};

const TIF_CODE: Record<TimeInForce, string> = {
  GTC: 'G',
  IOC: 'I',
  FOK: 'F',
};

export interface NewOrderPayload {
  op: OpCode; // "NO"
  id: string;
  u: string; // user id
  s: string; // symbol
  t: string; // type
  sd: string; // side
  tif: string; // time in force
  p?: string; // price (limit-like 전용)
  oq?: string; // origQty (base)
  oqq?: string; // origQuoteQty (quote, market-like BUY)
}

export interface CancelOrderPayload {
  op: OpCode; // "CO"
  id: string;
  u: string;
  s: string;
}

export function serializeNewOrder(order: Order): NewOrderPayload {
  const typeCode = TYPE_CODE[order.type];
  // undefined 직렬화는 엔진 전체를 죽일 수 있다 — 매핑 누락은 즉시 실패.
  if (!typeCode) {
    throw new Error(`No engine type code mapped for order type ${order.type}`);
  }

  const payload: NewOrderPayload = {
    op: Op.NEW_ORDER,
    id: order.id,
    u: order.userId,
    s: order.tickerSymbol,
    t: typeCode,
    sd: SIDE_CODE[order.side],
    tif: TIF_CODE[order.timeInForce],
  };

  // market-like는 p 미포함, limit-like는 price 필수.
  if (isMarketLike(order.type)) {
    if (order.origQuoteQty === null && order.origQty === null) {
      throw new Error(`market-like order ${order.id} has neither origQty nor origQuoteQty`);
    }
  } else {
    if (order.price === null) {
      throw new Error(`limit-like order ${order.id} has no price`);
    }
    payload.p = toScaledIntString(order.price);
  }

  if (order.origQty !== null) {
    payload.oq = toScaledIntString(order.origQty);
  }
  if (order.origQuoteQty !== null) {
    payload.oqq = toScaledIntString(order.origQuoteQty);
  }

  return payload;
}

export function serializeCancelOrder(order: Order): CancelOrderPayload {
  return {
    op: Op.CANCEL_ORDER,
    id: order.id,
    u: order.userId,
    s: order.tickerSymbol,
  };
}

// Re-export for callers
export { MarketType };
