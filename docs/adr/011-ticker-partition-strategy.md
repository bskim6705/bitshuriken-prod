# ADR-011: Ticker별 파티션 선지정 — Failover, Replay, 격리 전략

## Status
Superseded by [ADR-063](063-match-partition-buckets-and-stw.md) — "1 ticker = 1 partition" 선지정은 symbol-hash 고정 버킷(FNV-1a%P) + key 라우팅으로 대체. `Ticker.partition`이 DB 권위 소스라는 점·failover/replay/격리 의도는 승계.

## Context
[ADR-010](010-kafka-topic-unification-for-ordering.md)에서 Market별 in/out 토픽 구조를 정했다. 다음 결정 사항은 한 토픽 안의 파티션을 ticker에 어떻게 매핑할 것인가다.

기본 옵션 비교:
- **Hash 기반 (key=ticker_symbol)**: Kafka 기본 파티셔너 활용. 결정적이지만 불투명. 인스턴스 수가 바뀌거나 특정 ticker가 hot path가 되어도 운영자가 파악/조정 어렵다.
- **Round-robin**: 순서 보장 깨짐 (key 없으니 ticker별 파티션이 매번 달라질 수 있음). 부적합.
- **명시 매핑 (Ticker.partition)**: ticker마다 파티션을 사전에 박아둠. 가장 단순하고 결정적.

거래소처럼 ticker별 부하가 매우 비대칭이고, 특정 ticker만 격리 처리/장애 복구/replay 해야 하는 환경에서는 명시 매핑이 표준이다.

## Decision

### 1. Ticker.partition을 DB에 저장

```prisma
model Ticker {
  ...
  partition Int  // 상장 시 결정. ticker의 모든 메시지(in/out)가 사용
}
```

`match.spot.in`의 partition N과 `match.spot.out`의 partition N은 동일 ticker를 위한 lane이라는 약속.

### 2. 1 Ticker = 1 Partition

한 ticker에 정확히 한 파티션이 매핑된다. 다른 ticker와 partition을 공유하지 않는다.

### 3. 상장 시 sequential 자동 할당

- `partition = (SELECT MAX(partition) FROM Ticker WHERE marketType = ?) + 1` (또는 0 if 없음)
- Kafka 토픽의 파티션 수가 부족하면 admin API로 자동 확장 (`createPartitions`)
- 운영자가 partition 번호를 신경쓸 필요 없음

### 4. 매칭엔진 인스턴스 ↔ 파티션 매핑은 환경변수

```
MATCH_PARTITIONS=spot:0,1;futures:0
```

인스턴스가 시작 시 위 형식을 파싱하여 `consumer.assign([(topic, partition), ...])` 호출.

### 5. Consumer는 수동 assign

자동 consumer group rebalancing은 사용하지 않는다. 인스턴스는 시작 시 명시 assign으로 자기가 담당할 파티션을 선언한다.

이유:
- **In-memory orderbook 무결성**: 매칭엔진은 파티션별로 호가창 상태를 메모리에 유지한다. 자동 rebalance가 일어나면 같은 ticker가 두 인스턴스에서 처리될 수 있어 호가창이 손상된다.
- **결정성**: 인스턴스가 정확히 어떤 파티션을 처리하는지 운영자가 명시.
- **운영 안전성**: 인스턴스 추가/제거 시 운영자가 의식적으로 재할당.

단, group_id는 여전히 설정해서 offset을 Kafka에 저장한다 (replay 시 시작 위치 명확).

## Failover / Replay / 격리 시나리오

### Failover
- 매칭엔진 인스턴스 A가 죽으면, A가 담당하던 파티션을 다른 인스턴스(또는 새 인스턴스)에 env var로 재할당
- 새 인스턴스는 Kafka group offset부터 메시지를 다시 읽어 호가창을 재구축 (또는 스냅샷에서 복원)
- 다른 ticker는 영향 없음 (격리)

### Replay
- 특정 ticker만 replay하고 싶으면 그 ticker의 partition만 처음 offset부터 재처리
- partition 단위 격리이므로 다른 ticker에 영향 없음
- offset reset: `kafka-consumer-groups --reset-offsets --to-earliest --topic match.spot.in:N`

### 격리
- BTCUSDT(partition 0)에 문제가 생겨도 ETHUSDT(partition 1)는 정상 동작
- 매칭엔진 인스턴스를 ticker별로 분리 운영 가능 (1 인스턴스 = 1 파티션 = 1 ticker)

## Phase 2 (현재 구현하지 않음, 인지만)

상장 ticker가 1000+ 수준으로 늘어나거나 단일 Kafka 클러스터의 파티션 한계에 부딪히면 다음 단계가 필요할 수 있다:

- **Multi-cluster sharding**: 일부 ticker는 별도 Kafka 클러스터/토픽 그룹으로 분리. BE의 라우팅 레이어가 ticker → (cluster, topic) 매핑을 들고 있음.
- **Routing 매핑 위치 변경**: DB 컬럼(`Ticker.partition`)에서 코드/config service로 이동. 이때 마이그레이션 필요.
- **이 시점에 결정할 사항**: ticker 이동 시 호가창 마이그레이션, Kafka offset 인계, 다운타임 vs 무중단 정책.

지금은 Phase 1만 구현한다. Phase 2는 트리거가 발생하면 별도 ADR로 설계.

## Rationale

- **DB에 저장하는 것이 가장 단순**: 라우팅 정보가 도메인 객체 옆에 있어 코드/config 동기화 부담 없음. 신규 상장 = 트랜잭션 한 번.
- **1 ticker = 1 partition**: 격리 극대화. 작은~중간 규모(수백 ticker)에서 가장 명확한 모델. 디버깅, replay, 격리 처리 모두 단순.
- **Sequential auto-assign**: 운영자가 partition 번호를 외울 필요 없고 일관된 순서 유지.
- **수동 assign over 자동 rebalance**: 매칭엔진의 in-memory 상태와 파티션 소유권을 분리하지 않기 위해 명시 assign이 필수.

## Consequences

### 코드 변경
- `Ticker.partition` 필드 추가 (마이그레이션)
- `seed.ts`에서 ticker별 partition sequential 명시
- BE producer: ticker 조회 → topic + partition 결정 → kafkajs `producer.send({ topic, messages: [{ partition, value }] })`
- BE consumer (매칭 결과 수신): `match.{market}.out` 토픽들에 자기 책임 파티션을 명시 assign
- 매칭엔진 consumer: `MATCH_PARTITIONS` 환경변수 파싱 → `consumer.assign(...)` 호출
- 신규 ticker 등록 시: partition sequential 할당 + 필요 시 Kafka partition 확장

### 운영 영향
- 초기 토픽 4개에 ticker 수만큼 파티션 생성 (현재 ticker 4개 → 토픽당 4 파티션)
- 새 ticker 상장 절차: (1) Asset 등록 → (2) Ticker 등록(partition auto) → (3) Kafka partition 확장(필요 시) → (4) 매칭엔진 인스턴스 env var 갱신
- 파티션 수 변경: Kafka는 partition 추가만 지원, 감소 불가. ticker 삭제 시 partition은 idle (재사용 정책 별도 결정)

### 향후 결정 사항 (out of scope)
- 삭제된 ticker의 partition 재사용 정책
- DLQ(Dead Letter Queue) 전략
- Phase 2 (multi-cluster sharding) 트리거 조건과 마이그레이션 계획
- 호가창 스냅샷/체크포인트 전략 (failover 시 빠른 복구)
