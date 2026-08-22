import { OrderType } from '@prisma/client';

// market-like = 트리거/체결 시 엔진 'M'으로 가는 타입. 검증·잠금·환불·직렬화가 전부 이 분류를 쓴다.
const MARKET_LIKE: ReadonlySet<OrderType> = new Set<OrderType>([
  'MARKET',
  'STOP_LOSS',
  'TAKE_PROFIT',
]);

const STOP_TYPES: ReadonlySet<OrderType> = new Set<OrderType>([
  'STOP_LOSS',
  'STOP_LOSS_LIMIT',
  'TAKE_PROFIT',
  'TAKE_PROFIT_LIMIT',
]);

export function isMarketLike(type: OrderType): boolean {
  return MARKET_LIKE.has(type);
}

export function isLimitLike(type: OrderType): boolean {
  return !MARKET_LIKE.has(type);
}

/** BE가 보관하다 last price로 트리거하는 stop 계열 여부. */
export function isStopType(type: OrderType): boolean {
  return STOP_TYPES.has(type);
}
