# ADR-013: Match engine은 1 인스턴스 N ticker, Lane 패턴 + JSON config

## Status
Accepted (partition 핀 부분은 ADR-063으로 대체 — "1 partition = 1 ticker" → symbol-hash 버킷 + key 라우팅. Lane 패턴·1인스턴스 N ticker·JSON config는 유지)

## Context
매칭엔진 인스턴스를 ticker 단위로 어떻게 운영할지 결정이 필요하다. 검토한 두 모델:

- **1 인스턴스 = 1 ticker**: 코드 가장 단순. 격리 극대. K8s deployment ticker 수만큼.
- **1 인스턴스 = N ticker (Lane)**: 자원 효율. 단일 프로세스가 N개의 OrderBook 보유, 단일 consumer 루프로 (topic, partition) 라우팅.

## Decision

**1 인스턴스 N ticker, Lane 패턴 채택**. 각 ticker는 자체 `Lane` (= topic_in/topic_out/partition/OrderBook 묶음)을 가지며, 단일 consumer 루프가 메시지의 (topic, partition)으로 Lane을 lookup하여 dispatch한다.

ticker 목록과 메타정보는 JSON config 파일로 관리한다 (`MATCH_CONFIG_PATH` env로 경로 주입).

### 구조

```python
@dataclass(slots=True)
class Lane:
    topic_in: str
    topic_out: str
    partition: int
    book: OrderBook

# main loop
lanes: dict[(topic, partition), Lane] = load_lanes(CONFIG_PATH)
consumer.assign([(lane.topic_in, lane.partition) for lane in lanes.values()])
while True:
    msg = consumer.poll(...)
    lane = lanes[(msg.topic(), msg.partition())]
    ...dispatch by op...
```

### Config 형식

```json
{
  "tickers": [
    { "market": "spot", "symbol": "BTCUSDT", "partition": 0, "pricePrecision": 2, "qtyPrecision": 5 },
    ...
  ]
}
```

K8s 환경에서는 `MATCH_CONFIG_PATH=/etc/match/tickers.json`로 ConfigMap mount.

## Rationale

- **검증된 패턴**: 동일 패턴(단일 프로세스 + ticker별 lane)을 다른 프로젝트에서 100k orders/sec 이상으로 운영한 경험. Python single thread 한계 안에서 충분한 헤드룸.
- **자원 효율**: ticker당 Python 베이스라인(30~80MB) × 100 ticker = 3~8GB. 1=1 모델은 자원 부담 큼.
- **Kafka 연결 절약**: 인스턴스당 connection 1개. 1=1 모델은 ticker 수만큼의 connection.
- **운영 단순화**: K8s deployment 수가 적음 (market별 1개 또는 hot/cold 분리).
- **확장 유연**: hot ticker는 별도 인스턴스(+ config) 분리 가능. 단순한 ticker 그룹 분할.
- **Market 정보가 토픽에 있음**: OrderBook/Order/Trade 클래스에서 market 필드 제거, 단순화.

## Consequences

- 모든 ticker가 같은 GIL 안에서 처리됨. CPU intensive ticker가 다른 ticker를 지연시킬 가능성 있음 (실제 거래소 트래픽 패턴에서는 미미).
- Lane 추가 시 OrderBook 클래스가 partition을 자체 보유 (`book.partition`).
- Match engine 클래스는 `submit_new_order(book, taker)` 시그니처. OrderBook을 외부에서 주입받음 (engine은 라우팅 책임 없음).
- 향후 ticker 수 증가 시 ticker 그룹별 인스턴스 분할 (env로 분배). 코드 변경 없이 deploy만으로 확장.
- 진짜 한계 도달 시 (수백~천 ticker, ticker별 100k+ TPS): 프로세스 분할 또는 별도 매칭엔진 언어(Rust 등) 검토.

## 관계
- [ADR-005](005-match-engine-structure.md): 모듈 구조. Lane은 main.py 책임으로 추가.
- [ADR-010](010-kafka-topic-unification-for-ordering.md): 토픽 일원화 + op 필드. Lane이 topic_out 보유로 outbound publish.
- [ADR-011](011-ticker-partition-strategy.md): Ticker별 partition. Lane은 1 ticker에 partition 1개.
