import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { OrderListStatus, OrderSide, OrderStatus, OrderType, TimeInForce } from '@prisma/client';

/**
 * 가격/수량 필드는 ticker precision display string. eq/cqq는 OU 메시지 값 (DB 금지).
 * lastFilled/commission/tradeId는 직전 체결(TRADE) 디테일 — 체결 동반 OU에만 존재, 그 외 undefined.
 */
export interface ExecutionReportPayload {
  orderId: string;
  clientOrderId?: string;
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
  lastFilledQty?: string;
  lastFilledPrice?: string;
  commission?: string;
  commissionAsset?: string;
  tradeId?: string;
  ts: number;
}

/** ts = wallet.updatedAt epoch ms — FE가 자산별 max(ts)로 stale drop. */
export interface BalanceSnapshot {
  asset: string;
  free: string;
  locked: string;
  ts: number;
}

export interface ListStatusPayload {
  orderListId: string;
  symbol: string;
  status: OrderListStatus;
  orders: { orderId: string; status: OrderStatus }[];
  ts: number;
}

export type UserStreamName = 'executionReport' | 'outboundAccountPosition' | 'listStatus';

export interface UserStreamEvent {
  stream: UserStreamName;
  data: unknown;
}

const EVENT = 'user-event';

/**
 * User data stream 이벤트 허브. 순수 in-memory EventEmitter — 단일 BE 인스턴스 전제.
 * 게이트웨이가 onEvent로 단일 리스너를 등록해 userId별 소켓에 fanout.
 */
@Injectable()
export class UserStreamService {
  private readonly emitter = new EventEmitter();

  emitExecutionReport(userId: string, report: ExecutionReportPayload): void {
    this.emit(userId, { stream: 'executionReport', data: report });
  }

  emitAccountPosition(userId: string, balances: BalanceSnapshot[]): void {
    this.emit(userId, { stream: 'outboundAccountPosition', data: { balances } });
  }

  emitListStatus(userId: string, payload: ListStatusPayload): void {
    this.emit(userId, { stream: 'listStatus', data: payload });
  }

  onEvent(listener: (userId: string, event: UserStreamEvent) => void): () => void {
    this.emitter.on(EVENT, listener);
    return () => this.emitter.off(EVENT, listener);
  }

  private emit(userId: string, event: UserStreamEvent): void {
    this.emitter.emit(EVENT, userId, event);
  }
}
