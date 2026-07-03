import { randomUUID } from 'node:crypto';
import { ErrorCode } from './constants/error-codes';
import { DomainException } from './exceptions/domain.exception';

// Binance newClientOrderId 제약과 동일: 1~36자, [A-Za-z0-9-_.]
export const CLIENT_ORDER_ID_PATTERN = /^[A-Za-z0-9_.-]{1,36}$/;
export const CLIENT_ORDER_ID_MESSAGE = 'clientOrderId must be 1-36 chars of A-Z a-z 0-9 and . _ -';

/** 미지정 시 BE가 생성하는 clientOrderId. 패턴(≤36자)을 만족하는 uuid. */
export function generateClientOrderId(): string {
  return randomUUID();
}

/**
 * Order.create에서 올라온 P2002 판별. 그 경로의 유일한 unique insert는
 * (userId, tickerMarket, clientOrderId) 인덱스뿐이라 P2002 ⟺ clientOrderId 중복.
 */
export function isDuplicateClientOrderId(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

/**
 * 주문 insert 호출을 감싸 clientOrderId 중복(P2002)을 DomainException으로 변환.
 * DB unique 제약이 동시성 안전장치 — 사전 검사 없이 경합 패자도 깔끔한 에러로 반환.
 */
export async function createOrderOrThrowDuplicate<T>(create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (err) {
    if (isDuplicateClientOrderId(err)) {
      throw new DomainException(
        ErrorCode.ORDER_DUPLICATE_CLIENT_ID,
        'clientOrderId already in use',
      );
    }
    throw err;
  }
}
