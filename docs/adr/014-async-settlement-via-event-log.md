# ADR-014: Async settlement via append-only event log

## Status
Accepted

## Context

매칭엔진 → BE 흐름에서 체결 결과(`TR`, `OU`)를 받아 wallet `balance`/`locked`을 변동해야 한다. 단순한 구현은 match-result handler가 메시지 1건마다 양쪽 user wallet row를 직접 update하는 것.

문제: **wallet row는 hot key**.
- 활발한 maker(예: market maker bot) 한 명이 한 ticker에 거의 모든 호가에 참여
- 그 사용자의 wallet row가 매 체결마다 update → row lock 경합
- handler가 동기로 update하면 partition 전체 throughput이 그 한 명의 row lock에 묶임
- → ADR-013의 Lane 패턴(파티션 내부 직렬 처리)과 결합되면 hot maker가 ticker 전체 매칭 latency를 끌어내림

## Decision

wallet 변동을 **append-only event log**로 분리한다.

- match-result handler는 `SettlementEvent` row를 INSERT만 한다 (lock 없음, cross-row 충돌 없음)
- 별도 worker가 100ms 간격으로 PENDING event를 batch로 wallet에 반영
- handler 측에는 자기 order row의 status update와 settlement event INSERT만 존재

### 동기/비동기 경계

| 경로 | 모드 | 이유 |
|--|--|--|
| 주문 placement (`POST /orders`) | **동기 직접 update** | 잔고 부족 즉시 reject 필요. cross-user 충돌 없음 (자기 wallet만). |
| 매칭 결과(TR/OU) → wallet 변동 | **비동기 event** | cross-user. hot maker bottleneck 회피. |

### 멱등성

- `SettlementEvent.sourceKey` UNIQUE — TR이면 `tradeId`, dust 환불이면 `dust:{orderId}`
- 동일 메시지 재 consume 시 INSERT 충돌 → swallow
- worker가 event 적용 시 `updateMany({ where: { id, status: PENDING } })` claim → race 방지

### Order 상태 갱신은 분리

- `executedQty`/`cumulativeQuoteQty` 누적: worker가 event의 `orderLegs`로 처리 (cross-row 영향 없으므로 wallet과 같은 트랜잭션에 묶음)
- `status`: 매칭엔진이 OU에 단축 코드(`F`, `C` 등)로 직접 보내고, handler가 `prisma.order.update`로 동기 갱신. cross-user 충돌 없으므로 hot key 문제 없음.

## Rationale

- **Hot wallet bottleneck 제거**: handler는 sequential append만 → market 가용성 ↑
- **재해복구 친화**: event log replay만으로 wallet 상태 재구성 가능
- **단순 구현**: 단일 DB 안에서 처리. 별도 메시지 브로커/이벤트 스토어 불필요
- **트레이드오프**: `balance` 가시성에 worker latency(≤100ms) 만큼 지연. 사용자 UX 영향 미미. 주문 placement도 같은 `balance`를 보므로 일관성 유지.

## Consequences

- 새 모델 `SettlementEvent` (kind: TRADE | DUST_REFUND), enum `SettlementStatus` (PENDING | APPLIED), `legs`/`orderLegs` JSON column
- `@nestjs/schedule` 의존성 추가, `SettlementWorker`가 `@Interval(100)`으로 polling
- 다음은 본 ADR의 적용 범위 밖 (별도 작업):
  - DLQ / 영구 실패 격리
  - Worker 분산 (멀티 인스턴스 leader election)
  - Snapshot/checkpoint
- 위 한계 도달 시 (수십만 PENDING 누적, 수십초 worker latency 등): batch size 증가 / worker 분산 / 별도 streaming 인프라 검토

## 관계
- [ADR-008](008-asset-as-first-class-entity.md): Wallet/Asset 모델 기반
- [ADR-010](010-kafka-topic-unification-for-ordering.md): TR/OU 메시지 op 필드 — handler가 dispatch
- [ADR-012](012-user-sharding-considered-but-deferred.md): wallet 샤딩 안 함 → 단일 DB 트랜잭션 가능
- [ADR-013](013-match-engine-lane-architecture.md): Lane 패턴 — partition 내 직렬 처리 가정. handler row lock이 부재해야 Lane 처리량을 유지.
