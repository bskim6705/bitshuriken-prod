import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import {
  MarginMode,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionStatus,
  TimeInForce,
} from '@prisma/client';

export interface FuturesExecutionReport {
  orderId: string;
  clientOrderId?: string;
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
  // per-fill 디테일 — 직전 체결 1건 기준, 무체결 OU면 null
  lastFilledQty: string | null;
  lastFilledPrice: string | null;
  commission: string | null;
  commissionAsset: string | null;
  tradeId: string | null;
  realizedPnl: string | null;
  ts: number;
}

/** ts = wallet.updatedAt epoch ms — FE가 자산별 max(ts)로 stale drop. */
export interface FuturesBalanceSnapshot {
  asset: string;
  free: string;
  locked: string;
  ts: number;
}

export interface FuturesPositionSnapshot {
  symbol: string;
  qty: string; // signed: +롱 −숏
  entryPrice: string;
  isolatedMargin: string;
  leverage: number;
  marginMode: MarginMode;
  status: PositionStatus;
  markPrice: string | null; // 현재 mark — 미형성 시 null
  unrealizedPnl: string | null; // signed UPNL — mark 미형성 시 null
  liquidationPrice: string | null; // ISOLATED만 산출, CROSS는 null(FE가 REST 보충)
  ts: number;
}

/** 청산 사전 경고 — marginRatio가 warn 밴드에 진입할 때 1회 송출. 알림 전용(경제 효과 없음). */
export interface FuturesMarginCall {
  symbol: string;
  marginMode: MarginMode;
  marginRatio: string;
  markPrice: string;
  ts: number;
}

export type FuturesUserStreamName =
  | 'executionReport'
  | 'outboundAccountPosition'
  | 'positionUpdate'
  | 'MARGIN_CALL';

export interface FuturesUserStreamEvent {
  stream: FuturesUserStreamName;
  data: unknown;
}

const EVENT = 'futures.user.event';

/** futures 유저별 이벤트 버스 — consumer/worker가 emit, fuser gateway가 구독. */
@Injectable()
export class FuturesUserEventsService {
  private readonly emitter = new EventEmitter();

  emitExecutionReport(userId: string, report: FuturesExecutionReport): void {
    this.emit(userId, { stream: 'executionReport', data: report });
  }

  emitAccountPosition(userId: string, balances: FuturesBalanceSnapshot[]): void {
    this.emit(userId, { stream: 'outboundAccountPosition', data: { balances } });
  }

  emitPositionUpdate(userId: string, positions: FuturesPositionSnapshot[]): void {
    this.emit(userId, { stream: 'positionUpdate', data: { positions } });
  }

  emitMarginCall(userId: string, call: FuturesMarginCall): void {
    this.emit(userId, { stream: 'MARGIN_CALL', data: call });
  }

  onEvent(listener: (userId: string, event: FuturesUserStreamEvent) => void): () => void {
    this.emitter.on(EVENT, listener);
    return () => this.emitter.off(EVENT, listener);
  }

  private emit(userId: string, event: FuturesUserStreamEvent): void {
    this.emitter.emit(EVENT, userId, event);
  }
}
