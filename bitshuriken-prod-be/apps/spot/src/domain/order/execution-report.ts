import { Order, OrderStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { ExecutionReportPayload } from '../user-stream/user-stream.service';
import { TickerMeta } from '@app/core-domain/ticker/ticker-stats.service';

/** 직전 체결 디테일 — 체결 동반 OU에만 전달, 그 외(NEW/CANCELED/로컬 전이)는 생략. */
export interface FillDetail {
  lastFilledQty: Decimal;
  lastFilledPrice: Decimal;
  commission: Decimal;
  commissionAsset: string;
  tradeId: string;
}

/**
 * executionReport 페이로드 조립. eq/cqq는 호출자가 OU 메시지(또는 로컬 전이) 값으로 전달.
 * fill이 있으면 직전 체결가/량·수수료·tradeId를 누적 필드 옆에 싣는다.
 */
export function buildExecutionReport(
  order: Order,
  meta: TickerMeta,
  args: {
    executedQty: Decimal;
    cumulativeQuoteQty: Decimal;
    status: OrderStatus;
    ts: number;
    fill?: FillDetail;
  },
): ExecutionReportPayload {
  return {
    orderId: order.id,
    clientOrderId: order.clientOrderId ?? undefined,
    orderListId: order.orderListId ?? undefined,
    symbol: order.tickerSymbol,
    side: order.side,
    type: order.type,
    timeInForce: order.timeInForce,
    price: order.price !== null ? order.price.toFixed(meta.pricePrecision) : undefined,
    stopPrice: order.stopPrice !== null ? order.stopPrice.toFixed(meta.pricePrecision) : undefined,
    origQty: order.origQty !== null ? order.origQty.toFixed(meta.qtyPrecision) : undefined,
    origQuoteQty:
      order.origQuoteQty !== null ? order.origQuoteQty.toFixed(meta.pricePrecision) : undefined,
    executedQty: args.executedQty.toFixed(meta.qtyPrecision),
    cumulativeQuoteQty: args.cumulativeQuoteQty.toFixed(meta.pricePrecision),
    status: args.status,
    lastFilledQty: args.fill ? args.fill.lastFilledQty.toFixed(meta.qtyPrecision) : undefined,
    lastFilledPrice: args.fill ? args.fill.lastFilledPrice.toFixed(meta.pricePrecision) : undefined,
    commission: args.fill ? args.fill.commission.toFixed(8) : undefined,
    commissionAsset: args.fill?.commissionAsset,
    tradeId: args.fill?.tradeId,
    ts: args.ts,
  };
}
