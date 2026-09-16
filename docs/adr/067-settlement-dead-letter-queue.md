# ADR-067: 정산 워커 데드레터 큐 (poison 이벤트 격리)

## Status
Accepted (2026-07-12, 유저 결정)
> **[2026-09-16 배너]** spot 워커는 2단(fast-path 배치 → poison이면 per-event 폴백 → 격리; poison 1건이 배치 500건을 per-event로 떨어뜨리는 처리량 절벽). 양 워커가 settle 단일 프로세스([ADR-077](077-settlement-process-split-and-graceful-shutdown.md)). S2에서 'Wallet 행 부재' poison 원인은 소멸. DLQ 재적용 도구는 여전히 없고(감사 A15) failCounts는 인메모리.

## Context
정산은 async 이벤트 로그(ADR-014)를 spot/futures 워커가 100ms tick으로 드레인한다. 적용 불가
이벤트 1건이 throw하면 — futures 워커는 순서 보존을 위해 중단(break), spot 워커는 다음 tick마다
같은 이벤트를 재시도 — 해당 이벤트 뒤의 모든 정산이 영구 정지한다(관찰 #18, 실제 130건 고착 사례).
poison 이벤트를 격리/스킵/알림하는 장치가 없었다.

## Decision
- 워커가 이벤트별 연속 실패를 **인메모리로** 카운트한다(`SettlementEvent` 스키마 불변 — 아래 Rationale).
  `SETTLEMENT_MAX_ATTEMPTS`(=5, `libs/shared/src/constants/settlement.ts`) 도달 시 **QUARANTINED**
  상태로 격리하고 별도 테이블 **`SettlementDeadLetter`**(이벤트 사본 + lastError + attempts +
  quarantinedAt)에 기록한 뒤 **후속 이벤트를 진행**한다. 격리 미만 실패는 기존과 동일(futures:
  순서 보존 중단 후 재시도 / spot: 다음 이벤트 진행 후 재시도). 워커 재시작 시 카운트는 리셋되며
  poison 이벤트는 threshold를 다시 채우고 격리된다(~500ms).
- **마이그레이션 전 강등(degrade) 모드**: DLQ 스키마(enum 값·테이블)가 없으면 격리 시도가 throw
  → catch 후 기존 무한 재시도 동작으로 강등하고 "run the settlement-dlq migration" error 로그.
  마이그레이션이 적용되는 순간 자동 활성화된다.
- 가시성 3중: ① 워커가 격리 시 `QUARANTINED …` error 로그(매 실패도 attempt 카운트와 함께 로그),
  ② `SettlementDeadLetter` 테이블(운영자 조회·수동 재적용 근거), ③ 정합성 체커에 **F5** 추가 —
  DLQ에 1건이라도 있으면 monetary fail (`bitshuriken-prod-bots/src/integrity/dlq.ts`).

## Rationale
- 일시 장애(록 경합·DB 순단)는 5회 재시도(≈500ms)로 흡수되고, 결정적 실패만 격리된다.
- futures 이벤트는 포지션 전이 순서가 정합성 조건이라 "건너뛰고 계속"은 뒤 이벤트를 틀린 상태
  위에 적용할 수 있다. 그러나 격리는 조용한 스킵이 아니다 — 미적용 금전 이동이 테이블·로그·F5로
  드러나고, F1~F4가 파생 불일치를 잡는다. "전체 정산 정지 + 조용한 무한 재시도"보다 명백히 낫다.
- 정지 시 0 fail이어야 하는 측정 규율(feedback-026)과 정합: 격리 발생 = 측정에서 반드시 red.

## Consequences
- 스키마 변경: `QUARANTINED` enum 값 + `SettlementDeadLetter` 모델(**`SettlementEvent`는 불변**) —
  `npx prisma migrate dev --name settlement-dlq` 필요 (마이그레이션은 유저 실행). 적용 전에는
  강등 모드로 기존 동작 유지, 적용 즉시 DLQ 활성.
- 격리된 이벤트의 수동 재적용 절차(검토 후 PENDING 복귀 or 폐기)는 운영 정책으로 후속 결정.
- F5 체커는 테이블 부재 시 warn으로 대체.
- **교훈(사고 기록)**: 최초 구현이 `SettlementEvent.attempts` 컬럼을 추가했는데, Prisma client는
  모델의 전 컬럼을 SELECT/RETURNING하므로 **마이그레이션 전 client 재생성만으로 기존 쿼리
  (`settlementEvent.findMany/create`)가 전부 깨져** 엔진 아웃풋 컨슈머가 ~25분 정지했다
  (2026-07-12 17:26–17:52). 기존 모델에 컬럼을 더하는 변경은 "미사용 경로"라도 배포-마이그레이션
  순서에 안전하지 않다 — 신규 테이블·enum 값 추가만이 pre-migration 배포에 안전하다.
