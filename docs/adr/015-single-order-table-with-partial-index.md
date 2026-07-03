# ADR-015: Order 테이블 단일 유지 (OpenOrder 분리 보류)

## Status
Accepted

## Context

체결이 누적되면 `Order` 테이블은 무한 grow한다. 활성(open) 주문은 전체의 극소수, 나머지는 terminal(FILLED/CANCELED/...)이다. 이 구조에서 자연스러운 의문:

- **OpenOrder 테이블 분리**: 활성 주문만 작은 별도 테이블에 두고 terminal 도달 시 history(`Order`) 테이블로 이동
- **단일 Order 테이블**: 현재 구조 유지, 필요시 partial index 등으로 활성 주문 조회 최적화

## Decision

**단일 `Order` 테이블 유지.** OpenOrder 분리는 보류한다. 병목이 실제로 관측되면 그때 재검토.

## Rationale

- 매칭엔진이 in-memory 호가창(ADR-013 Lane)을 보유 → BE는 호가창 조회를 거의 안 함. read-side 부담이 작음
- BE의 `Order` 주 사용처:
  - 사용자 history 조회 (`WHERE userId`, PK/index 기반)
  - settlement worker / handler의 order lookup (PK 기반)
  - 위 둘 다 테이블 grow의 영향이 적음
- 분리 도입 시 비용:
  - 한 주문의 lifecycle이 두 테이블에 걸침 → 트랜잭션 경계 추가
  - Trade의 외래키 정합성 유지 복잡 (history에 항상 존재한다는 invariant)
  - match-result handler / order service / settlement 코드 모두 양쪽 테이블 조작
- 단일 테이블이 여전히 살아남는 경로 (필요 시 단계적 도입):
  1. PostgreSQL partial index — 활성 status에 한정한 인덱스로 호가 관련 쿼리 최적화 (테이블은 그대로)
  2. 파티셔닝 (createdAt 월별 등) — VACUUM/통계 분리
  3. 마지막 수단으로 OpenOrder 분리

## Consequences

- 코드 단순함 유지. order id 하나로 어떤 상태든 조회 가능
- 테이블이 시간이 지남에 따라 grow함 — 다음 신호가 보이면 ADR 재작성:
  - 사용자 history 조회 latency 증가
  - VACUUM/autovacuum 시간 증가, bloat
  - settlement handler/worker의 order lookup latency 증가
  - 활성 주문 조회 (만약 추가되면)에서 인덱스 효율 저하
- 그 시점에 partial index → 파티셔닝 → 테이블 분리 순으로 단계적 검토

## 관계
- [ADR-013](013-match-engine-lane-architecture.md): 매칭엔진이 in-memory 호가창 보유. BE의 Order read 부담이 작은 근거.
- [ADR-014](014-async-settlement-via-event-log.md): settlement worker가 order PK로 lookup. 분리 도입 시 worker도 양쪽 테이블 조작 필요.
