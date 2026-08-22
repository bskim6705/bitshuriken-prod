import { OrderSide, OrderStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { fromScaledIntString } from '@app/shared/decimal';
import { Op } from './topics';

const SIDE_FROM_CODE: Record<string, OrderSide> = {
  B: 'BUY',
  S: 'SELL',
};

// 매칭엔진 engine/order.py OrderStatus enum 값과 1:1 매핑.
const STATUS_FROM_CODE: Record<string, OrderStatus> = {
  N: 'NEW',
  O: 'OPEN',
  P: 'PARTIAL',
  F: 'FILLED',
  C: 'CANCELED',
  R: 'REJECTED',
  E: 'EXPIRED',
};

export interface TradeData {
  tradeId: string;
  symbol: string;
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
  takerSide: OrderSide;
  price: Decimal;
  qty: Decimal;
  ts: number;
}

export interface OrderUpdateData {
  orderId: string;
  userId: string;
  status: OrderStatus;
  executedQty: Decimal;
  cumulativeQuoteQty: Decimal;
  ts: number;
}

/** raw int*10^8 string의 [price, qty] 쌍. decimal 변환은 응답 시점에 수행. */
export interface DepthDiffData {
  symbol: string;
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
  ts: number;
}

interface IncomingMsg {
  op?: string;
  [key: string]: unknown;
}

export function parseTradeMsg(payload: IncomingMsg): TradeData {
  if (payload.op !== Op.TRADE) {
    throw new Error(`Expected op=${Op.TRADE}, got ${String(payload.op)}`);
  }
  return {
    tradeId: payload.tid as string,
    symbol: payload.s as string,
    makerOrderId: payload.mo as string,
    takerOrderId: payload.to as string,
    makerUserId: payload.mu as string,
    takerUserId: payload.tu as string,
    takerSide: SIDE_FROM_CODE[payload.sd as string],
    price: fromScaledIntString(payload.p as string),
    qty: fromScaledIntString(payload.q as string),
    ts: payload.ts as number,
  };
}

export function parseOrderUpdateMsg(payload: IncomingMsg): OrderUpdateData {
  if (payload.op !== Op.ORDER_UPDATE) {
    throw new Error(`Expected op=${Op.ORDER_UPDATE}, got ${String(payload.op)}`);
  }
  return {
    orderId: payload.id as string,
    userId: payload.u as string,
    status: STATUS_FROM_CODE[payload.st as string],
    executedQty: fromScaledIntString(payload.eq as string),
    cumulativeQuoteQty: fromScaledIntString(payload.cqq as string),
    ts: payload.ts as number,
  };
}

export function parseDepthDiffMsg(payload: IncomingMsg): DepthDiffData {
  if (payload.op !== Op.DEPTH_DIFF) {
    throw new Error(`Expected op=${Op.DEPTH_DIFF}, got ${String(payload.op)}`);
  }
  return {
    symbol: payload.s as string,
    lastUpdateId: payload.u as number,
    bids: payload.b as [string, string][],
    asks: payload.a as [string, string][],
    ts: payload.ts as number,
  };
}
