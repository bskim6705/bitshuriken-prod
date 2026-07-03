# ADR-020: Orderbook depth via diff stream + BE OrderBook reconstruction

## Status
Accepted

## Context

Public market data 중 **orderbook depth** (`GET /spot/market/depth`) 와 **bookTicker** (`GET /spot/market/book-ticker`) 가 필요하다.

핵심 제약:
- 호가창 source of truth는 매칭엔진의 in-memory state (ADR-013 Lane). BE는 직접 알 수 없음.
- BE의 `Order` 테이블 NEW/OPEN/PARTIAL 조회는 정산 worker latency (ADR-014) 때문에 어긋남. 또한 in-memory level별 합산 qty를 모름.
- **활성 ticker는 unique price level이 매우 많을 수 있음** — 한 ticker에 주문 100만 가능 시나리오. full snapshot이 비현실적.
- **한 inbound message가 OB 100 level 이상 변경 가능** — taker 한 명이 여러 maker와 매칭되면 매 fill마다 partial_fill / cancel 발생.
- 미래 WebSocket diff stream / kline / 24h ticker / bookTicker 등 derived data 도입 시 같은 base를 재사용해야 효율.

## Decision

**매칭엔진이 매 inbound message 처리 결과로 발생한 OB level 변경을 한 batch diff로 묶어 별도 Kafka topic으로 publish한다. BE는 자체 in-memory OrderBook을 reconstruction하고, depth와 bookTicker는 그 OB에서 자연 파생한다.**

### 1. Source: 매칭엔진 → Kafka diff (snapshot/recovery 없음)

- 별도 topic: `match.{spot|futures}.book` (outbound와 분리)
- partition은 ticker partition 그대로 (ADR-011)
- **Snapshot 없음** — 100만 order ticker 시나리오에서 비현실적
- **Recovery 없음 (Phase 1)** — sequence gap 감지 / snapshot reconcile은 미래 작업

### 2. Diff emit 단위 = per-inbound-message batch

- 한 NewOrderMsg / CancelOrderMsg 처리로 발생한 모든 OB level 변경을 한 diff에
- 매칭 1건이 100 level 변경 → 100 level 한 메시지에
- 변경 0이면 emit 안 함

근거:
- per-op (매 OB 변경마다 emit): 너무 chatty. 매칭 100건이면 100 emit. 부담
- 100ms batch (Binance @depth@100ms): latency 추가 + 매칭엔진에 timer 코드 추가
- **inbound batch가 자연스러운 boundary** — 한 NewOrderMsg는 atomic한 매칭 단위. 그 단위로 emit하면 latency 0, 자연 throttling

### 3. Diff message format

```json
{
  "op": "DPD",
  "s": "BTCUSDT",
  "ts": 1234567890,
  "u": 12345,
  "b": [
    ["50000.00000000", "1.50000000"],
    ["49999.00000000", "0"]
  ],
  "a": [
    ["50001.00000000", "0.80000000"]
  ]
}
```

- 가격/수량은 사람용 decimal string, 8자리. int*10^8 → decimal 변환
- `qty = "0"`은 level 제거 (Binance 패턴)
- `u`는 batch 적용 후의 OrderBook.seq

### 4. 매칭엔진 OrderBook에 dirty-level tracking

`OrderBook.add` / `cancel` / `partial_fill`이 변경된 (side, price)를 `_dirty_levels`에 marking. main loop가 inbound 처리 직후 `drain_dirty_levels()`로 회수하고 diff message로 emit.

### 5. BE OrderBook 자료구조 + diff applier

`domain/orderbook/orderbook-cache.service.ts`:
- `Map<"${market}/${symbol}", OrderBookState>` — state는 `{bids: Map<priceStr, qtyStr>, asks: Map<priceStr, qtyStr>, lastUpdateId}`
- `applyDiff(market, symbol, diff)`: level upsert. qty=0이면 delete. lastUpdateId 갱신
- `getDepth(market, symbol, limit)`: top N (read 시점에 sort)
- `getBookTicker(market, symbol)`: best bid/ask 직접 추출

자료구조 선택:
- 단순 `Map` + read 시 sort. unique price level 수천~수만 가정 시 sort 비용 OK
- 50 level만 잘라야 하므로 partial sort 가능하지만 MVP는 full sort
- 미래 성능 이슈 시 `sorted-btree` 라이브러리 도입

### 6. Gap handling: Phase 1은 무시 (운영 책임)

- 첫 diff: 무조건 적용 (INIT 상태)
- 이후 diff: 그대로 적용 (sequence 검증 안 함)
- gap 발생 가능 상황:
  - **BE가 매칭엔진보다 늦게 부팅**: 매칭엔진이 그 사이 emit한 메시지는 BE consumer offset 정책에 따라 skip 또는 buffer. **운영 정책: 매칭엔진 → BE 부팅 순서 강제**.
  - **BE 재시작**: OB 전체 잃음. 매칭엔진의 다음 diff부터 누적되지만 base가 빈 상태. 운영자가 인지하고 매칭엔진도 함께 재시작.
- recovery 메커니즘은 별도 작업으로 미룸

### 7. bookTicker는 BE OB에서 자연 파생

- 매칭엔진에 별도 emit 흐름 추가 안 함
- BE OB가 자체적으로 매 diff 적용 후 best bid/ask를 알고 있음
- `getBookTicker` 호출 시 즉시 응답

이게 본 ADR의 핵심 가치 — depth와 bookTicker가 같은 BE OB에서 파생되어 일관성과 미래 확장성 모두 확보.

## Considered alternatives

### Alt A. Snapshot-only (100ms throttled)
- 매칭엔진이 100ms마다 lane별 top-50 snapshot publish
- BE는 dumb cache (snapshot 그대로 덮어쓰기)
- 단순하지만 BE는 derived data 파생 못 함 (bookTicker, kline 등은 별도 흐름 필요)
- 미래 WebSocket diff 도입 시 다른 메커니즘 필요 → redo
- 채택 안 함 (제대로 한 번에 가는 게 ROI 큼)

### Alt B. Snapshot + diff hybrid (Binance @depth + REST snapshot 패턴)
- snapshot과 diff 둘 다 emit. client가 snapshot 받고 그 시점 이후 diff만 적용
- 가장 정교, production-grade
- snapshot 자체가 100만 order ticker에서 비현실적 — Binance도 활성 ticker는 partial book만 5/10/20 level snapshot
- recovery 메커니즘 (sequence gap, reconcile) 필요
- 미래 작업으로 검토

### Alt C. Per-op diff
- 매 OB 변경마다 1 emit
- 너무 chatty. 매칭 1건이 100 emit
- 채택 안 함

### Alt D. 100ms batch diff (Binance @depth@100ms 스타일)
- 100ms 윈도우 동안 변경을 누적해서 한 메시지로 emit
- latency +100ms. 매칭엔진에 timer 코드 + 누적 버퍼 필요
- inbound batch가 더 자연스럽고 latency 0
- 채택 안 함

### Alt E. DB 조회
- 정산 worker latency로 부정확
- in-memory level 합산 정보 없음
- 채택 안 함

### Alt F. Redis cache
- 매칭엔진이 Redis에 SET, BE가 GET
- 단일 BE에서 불필요
- Redis가 빛나는 시점:
  1. 부하 누적 (in-memory map이 GC 압박)
  2. 멀티 인스턴스 BE의 일관성
  3. WebSocket diff stream의 base snapshot 공유
- 미래 결정

## Rationale

- **inbound batch가 자연스러운 boundary** — 매칭엔진의 atomic 처리 단위와 일치
- **BE OB가 모든 derived data의 source** — depth, bookTicker, 미래 WS diff stream / kline 일부 / 24h ticker 모두 같은 OB에서
- **snapshot 없는 게 100만 order 시나리오에 합리적** — full snapshot 자체가 traffic 폭발
- **recovery 미루는 것이 MVP에 합리적** — Phase 1은 운영 책임. 미래에 한 번에 도입 (snapshot/sequence/WS와 함께)
- **bookTicker가 free** — BE OB가 best를 자체 알므로

## Operational note (Phase 1 한계 — 매우 중요)

본 ADR은 recovery 메커니즘이 없다. 다음 운영 규칙을 따라야 함:

1. **부팅 순서**: 매칭엔진을 먼저 띄우고, BE를 그 다음. 반대로 하면 BE consumer가 매칭엔진의 첫 OB 변경을 놓침.
2. **재시작**: BE를 재시작하면 in-memory OB 전체 잃음. 매칭엔진도 함께 재시작해야 일관성 회복. 운영자가 인지.
3. **Kafka consumer offset**: BE consumer가 처음 group join 시 KafkaJS default(`latest`)에 따라 과거 메시지 skip 가능. depth diff 누락으로 cache가 옛 상태로 남음.

**위 한계는 의도적으로 미해결 상태로 둔다.** orderbook failover / reconcile / replay / recovery 정책은 별도 작업에서 한 번에 정리한다 (snapshot, sequence gap 감지, BE OB warm start, KafkaJS `fromBeginning` 정책 포함). 본 ADR 범위에서는 위 위험을 인지하고 운영 책임으로 가정.

## Consequences

- 매칭엔진 OrderBook에 dirty tracking 추가 (작은 변경)
- 매칭엔진 main loop에 publish 한 줄 추가 (per-inbound)
- BE 새 모듈 `domain/orderbook` (OrderBookCacheService)
- BE 새 Kafka consumer `infra/messaging/market-data.controller`
- BE 새 REST endpoint 2개 (depth + book-ticker)
- bookTicker가 자동으로 따라옴
- 미래 WebSocket diff stream은 같은 diff message를 client로 forward만 하면 됨
- 미래 kline / 24h ticker가 BE OB 위에 자연스럽게 추가 가능
- 매칭엔진/BE 코드에 미래 진화 경로 (recovery, WebSocket) TODO 주석 명시 — 미래의 자기/agent가 단서 잡기 쉽도록

## 관계
- [ADR-005](005-match-engine-structure.md): 메시지 축약 + string 직렬화
- [ADR-010](010-kafka-topic-unification-for-ordering.md): topic 정책. 본 ADR이 새 topic family `match.{market}.book` 추가
- [ADR-011](011-ticker-partition-strategy.md): partition 전략 그대로
- [ADR-013](013-match-engine-lane-architecture.md): Lane 패턴. dirty tracking은 lane.book에
- [ADR-014](014-async-settlement-via-event-log.md): 정산 worker latency가 본 ADR의 동기 (DB 조회 부정확 이유)
- [ADR-018](018-product-prefix-and-deployment-options.md): 단일 BE 가정 (S0)
