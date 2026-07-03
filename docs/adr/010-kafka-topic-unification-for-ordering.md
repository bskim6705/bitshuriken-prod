# ADR-010: Kafka 토픽 일원화로 메시지 순서 보장

## Status
Accepted

## Context
지금까지의 임시 구현은 단일 토픽(`match.new-order`)에 모든 ticker의 주문을 던지고, 메시지 본문의 `m`(market) 필드로 SPOT/FUTURES를 구분했다. 또한 `match.new-order`와 `match.cancel-order`를 분리하는 방향도 검토했다.

문제는 **메시지 종류 간 순서 보장**이다. Kafka는 **같은 파티션 안에서만** 순서를 보장한다. 만약 `new-order`와 `cancel-order`를 별도 토픽으로 두면, 동일 ticker라도 두 토픽 사이의 도착 순서는 보장되지 않는다. BE가 new → cancel 순으로 보내도 매칭엔진이 cancel을 먼저 받을 수 있다 (cancel 대상 주문이 없어서 실패).

또한 market(SPOT/FUTURES)을 메시지 본문 필드로 구분하는 것은 토픽 이름이 가져야 할 정보를 본문에 중복 기록하는 셈이고, 장애 격리 단위로도 부적절하다.

## Decision

### 1. Topic은 Market별 + 방향(in/out)별 1개씩

```
match.spot.in       # op: NO (new-order) | CO (cancel-order)
match.spot.out      # op: TR (trade)     | OU (order-update)

match.futures.in
match.futures.out
```

한 market의 inbound 메시지는 하나의 토픽에 합치고, outbound 메시지도 하나의 토픽에 합친다.

### 2. 메시지 본문에 `op` 필드로 종류 구분

| op    | 의미                       | 사용 토픽       |
| ----- | -------------------------- | --------------- |
| `NO`  | New Order                  | `*.in`          |
| `CO`  | Cancel Order               | `*.in`          |
| `TR`  | Trade                      | `*.out`         |
| `OU`  | Order Update               | `*.out`         |

매칭엔진/BE consumer는 메시지 수신 시 `op` 필드로 dispatch한다.

### 3. 메시지 본문에서 `m`(market) 필드 제거

토픽 이름이 이미 market 정보를 담고 있다. 중복 제거.

## Rationale

- **순서 보장이 핵심 동기**: 같은 ticker의 new와 cancel이 동일 파티션에 들어가면 Kafka가 순서를 보장한다. 종류는 본문 필드로 구분 가능하므로 토픽을 굳이 분리할 이유가 없다.
- **Market별 토픽 분리**: 장애 격리, 독립 스케일링 가능. SPOT 토픽이 죽어도 FUTURES에 영향 없음. SPOT/FUTURES 트래픽이 비대칭이면 토픽별로 다른 파티션 수를 가질 수도 있다.
- **`op` 필드는 2자**: payload 크기 영향 무시 가능.

## Consequences

### 코드 변경
- 메시지 schema에서 `m` 필드 제거, `op` 필드 추가
- BE producer가 ticker를 보고 `match.{market}.in` 토픽 결정
- BE consumer가 `match.{market}.out` 토픽 listen
- 매칭엔진 consumer가 `op` 필드로 dispatch (NO → 매칭, CO → 취소)
- Topic 이름과 op 코드를 상수 모듈로 모음 (예: `src/kafka/topics.ts`, `messaging/topics.py`)

### 운영 영향
- Kafka 클러스터에 초기 토픽 4개 (`match.spot.in/out`, `match.futures.in/out`) 생성
- 새 market 추가 시 토픽 2개 추가

## 관계
- 파티션 할당 전략은 별도 ADR ([ADR-011](011-ticker-partition-strategy.md)).
- ADR-005 (메시지 축약): `m` 제거 + `op` 추가에 따른 minor 갱신.
