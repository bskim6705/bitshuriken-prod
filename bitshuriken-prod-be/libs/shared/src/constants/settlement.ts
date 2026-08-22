/**
 * 정산 워커 DLQ 정책 (ADR-067). 정책 상수는 코드에 둔다(feedback-020).
 *
 * 이벤트 1건이 이 횟수만큼 연속 적용 실패하면 QUARANTINED로 격리하고 SettlementDeadLetter에
 * 사본을 남긴 뒤 후속 이벤트를 진행한다 — poison 이벤트 1건이 정산 파이프라인 전체를 정지시키는
 * 것(관찰 #18)을 막는다. 격리 = 금전 이동 미적용이므로 운영자 검토 대상이다.
 * tick 간격 100ms 기준, 일시 장애(록 경합·DB 순단)는 재시도로 흡수되고 결정적 실패만 격리된다.
 */
export const SETTLEMENT_MAX_ATTEMPTS = 5;
