import { Decimal } from '@prisma/client/runtime/library';

/**
 * 정산 워커의 mark 의존 최소면 (M1): 워커는 WS 포지션 스냅샷 보강에만 mark를 쓰고(nullable),
 * 정산 수학의 mark는 legs가 생성 시점에 동봉한다. 정산 프로세스에는 mark 소스가 없으므로
 * null-리더를 바인딩 — MarkPriceService(오더북 캐시·인덱스 컨슈머)를 끌고 오지 않는다.
 */
export const MARK_READER = Symbol('MARK_READER');

export interface MarkReader {
  tryGetMark(symbol: string): Decimal | null;
}

export const NULL_MARK_READER: MarkReader = { tryGetMark: () => null };
