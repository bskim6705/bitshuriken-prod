import { OrderSide, SettlementEvent } from '@prisma/client';

// futures SettlementEvent legs 형태. consume 시점에는 raw 사실만 — 파생값 금지.
// 모르는 형태는 throw (PENDING 유지, 조용한 유실 방지).

/** FUTURES_TRADE legs[0] — raw fill. 수치는 Decimal 직렬화 string. */
export interface FuturesTradeLeg {
  symbol: string;
  price: string;
  qty: string;
  makerOrderId: string;
  makerUserId: string;
  takerOrderId: string;
  takerUserId: string;
  takerSide: OrderSide;
  makerFeeBps: number;
  takerFeeBps: number;
}

/** FUTURES_TRADE orderLegs — spot과 동일 형태 (worker가 increment). */
export interface FuturesOrderLeg {
  orderId: string;
  executedQtyDelta: string;
  cumulativeQuoteQtyDelta: string;
}

/** FUTURES_REFUND legs[0]. finalExecutedQty는 terminal OU 메시지의 eq. */
export interface FuturesRefundLeg {
  orderId: string;
  userId: string;
  finalExecutedQty: string;
}

/** FUNDING legs[i] — 펀딩 스케줄러 스냅샷 값 (apply 시점 재조회 금지, zero-sum 기준). */
export interface FundingLeg {
  userId: string;
  symbol: string;
  rate: string;
  mark: string;
  qty: string; // signed
}

/**
 * LIQUIDATION_TAKEOVER legs[0].
 * qty/entryPrice/margin 없음 = 청산 모니터 생산 — 유저 포지션 잔량을 BP로 인수.
 * 있음 = worker flip IM 부족 생산 — 유저 포지션은 이미 flat, 명시 내용으로 기금에 합산.
 */
export interface TakeoverLeg {
  userId: string;
  symbol: string;
  qty?: string; // signed
  entryPrice?: string;
  margin?: string;
}

function legsOf(event: SettlementEvent): Record<string, unknown>[] {
  if (!Array.isArray(event.legs)) {
    throw new Error(`event ${event.id}: legs must be an array`);
  }
  return event.legs.map((raw, i) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`event ${event.id}: unexpected leg shape at [${i}]`);
    }
    return raw as Record<string, unknown>;
  });
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

export function parseTradeLeg(event: SettlementEvent): FuturesTradeLeg {
  const legs = legsOf(event);
  if (legs.length !== 1) {
    throw new Error(`event ${event.id}: FUTURES_TRADE expects exactly 1 leg`);
  }
  const leg = legs[0];
  const valid =
    isStr(leg.symbol) &&
    isStr(leg.price) &&
    isStr(leg.qty) &&
    isStr(leg.makerOrderId) &&
    isStr(leg.makerUserId) &&
    isStr(leg.takerOrderId) &&
    isStr(leg.takerUserId) &&
    Object.values(OrderSide).includes(leg.takerSide as OrderSide) &&
    typeof leg.makerFeeBps === 'number' &&
    typeof leg.takerFeeBps === 'number';
  if (!valid) {
    throw new Error(`event ${event.id}: unexpected FUTURES_TRADE leg shape`);
  }
  return leg as unknown as FuturesTradeLeg;
}

export function parseOrderLegs(event: SettlementEvent): FuturesOrderLeg[] {
  if (!Array.isArray(event.orderLegs)) {
    throw new Error(`event ${event.id}: orderLegs must be an array`);
  }
  return event.orderLegs.map((raw, i) => {
    const leg = raw as Record<string, unknown> | null;
    const valid =
      leg !== null &&
      typeof leg === 'object' &&
      isStr(leg.orderId) &&
      isStr(leg.executedQtyDelta) &&
      isStr(leg.cumulativeQuoteQtyDelta);
    if (!valid) {
      throw new Error(`event ${event.id}: unexpected order leg shape at [${i}]`);
    }
    return leg as unknown as FuturesOrderLeg;
  });
}

export function parseRefundLeg(event: SettlementEvent): FuturesRefundLeg {
  const legs = legsOf(event);
  if (legs.length !== 1) {
    throw new Error(`event ${event.id}: FUTURES_REFUND expects exactly 1 leg`);
  }
  const leg = legs[0];
  if (!isStr(leg.orderId) || !isStr(leg.userId) || !isStr(leg.finalExecutedQty)) {
    throw new Error(`event ${event.id}: unexpected FUTURES_REFUND leg shape`);
  }
  return leg as unknown as FuturesRefundLeg;
}

export function parseFundingLegs(event: SettlementEvent): FundingLeg[] {
  return legsOf(event).map((leg, i) => {
    const valid =
      isStr(leg.userId) &&
      isStr(leg.symbol) &&
      isStr(leg.rate) &&
      isStr(leg.mark) &&
      isStr(leg.qty);
    if (!valid) {
      throw new Error(`event ${event.id}: unexpected FUNDING leg shape at [${i}]`);
    }
    return leg as unknown as FundingLeg;
  });
}

export function parseTakeoverLeg(event: SettlementEvent): TakeoverLeg {
  const legs = legsOf(event);
  if (legs.length !== 1) {
    throw new Error(`event ${event.id}: LIQUIDATION_TAKEOVER expects exactly 1 leg`);
  }
  const leg = legs[0];
  if (!isStr(leg.userId) || !isStr(leg.symbol)) {
    throw new Error(`event ${event.id}: unexpected LIQUIDATION_TAKEOVER leg shape`);
  }
  const hasContent =
    leg.qty !== undefined || leg.entryPrice !== undefined || leg.margin !== undefined;
  if (hasContent && (!isStr(leg.qty) || !isStr(leg.entryPrice) || !isStr(leg.margin))) {
    throw new Error(
      `event ${event.id}: LIQUIDATION_TAKEOVER content legs require qty/entryPrice/margin`,
    );
  }
  return leg as unknown as TakeoverLeg;
}
