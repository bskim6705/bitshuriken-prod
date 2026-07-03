# ADR-034: 매칭엔진 상태 영속화 — 스냅샷 + bounded replay + BE 멱등 재방출

## Status
Accepted

## Context

매칭엔진은 인메모리 전용이라 크래시/재시작 시 모든 미체결 주문이 소실된다. BE의 locked 자금은 고아가 되고, futures 청산은 CO 대상을 잃는다. 기존 운영 규칙("엔진 재시작 = 전체 재시작 + 빈 책")은 프로덕션에서 성립하지 않는다.

또한 consumer가 `enable.auto.commit=True`(~5s)라 커밋 시점과 처리 시점이 어긋나 그 자체로 유실/중복 창이 있었다.

핵심 관찰: **inbound 토픽(`match.*.in`)이 이미 완전한 WAL이고, 매칭은 결정적(가격-시간 우선, 단일 스레드)이다.** 같은 메시지를 같은 순서로 재처리하면 책이 동일하게 재구성된다. 문제는 ① 어디서부터 다시 먹일지(전체 replay는 retention에 막히고 비용도 큼) ② 재처리 구간의 outbound(TR/OU/DPD) 재방출을 어떻게 무해화할지 둘로 환원된다.

검토 후 기각한 대안:
- **BE 재주입** (엔진 무상태 유지, BE가 open orders 재전송): 부분체결 주문의 OU `eq`(절대값)가 0부터 재시작해 DB와 영구 불일치, 크래시 직전 미처리 NO 유실, 재주입과 라이브 주문의 순서 경합.
- **Kafka EOS** (트랜잭션 프로듀서): exactly-once를 인프라로 풀 수 있으나 운영 복잡도가 규모에 과함. 아래 결정이 같은 효과를 BE의 기존 멱등성으로 얻는다.

## Decision

### 1. 주기 스냅샷 — 상태와 오프셋을 원자로 저장

- 엔진이 lane별로 **30s 주기(dirty lane만, 코드 상수)** 스냅샷을 `match.{market}.state` **log-compacted 토픽**(key=symbol, lane과 동일 partition)에 발행한다.
- 스냅샷 내용: `{ epoch, trade_seq, seq, offset(마지막 처리 inbound offset), bids/asks(가격레벨 순 + 레벨 내 FIFO 순서 보존된 주문 전체) }`.
- 단일 스레드 루프의 **메시지 처리 사이**에만 스냅샷을 찍으므로 상태-오프셋 원자성은 구조적으로 보장된다(락 불필요).
- 저장소로 Kafka를 쓰는 이유: 신규 인프라 0, PVC 없이 동작, compaction이 key별 최신만 유지.

### 2. 부팅 복구 — bounded replay

- lane별로 state 토픽에서 자기 key의 최신 스냅샷을 읽어 책을 복원하고, inbound consumer를 `snapshot.offset + 1`로 **seek** 한다(이미 manual assign — ADR-013).
- 이후는 일반 처리 — 재처리 구간(≤ 스냅샷 주기)의 outbound는 **그대로 재방출**하고 BE가 멱등 흡수한다(아래 4).
- **스냅샷이 없으면**: 빈 책 + 새 epoch + inbound `OFFSET_END` seek. 임의 과거 suffix를 빈 책에 replay하면 가짜 매칭이 발생하므로 금지 — 기존 "재시작 = 빈 책" 의미를 유지한다. 첫 도입/신규 ticker는 빈 책 상태에서 시작한다.
- **auto-commit 제거**: 오프셋의 유일한 출처는 스냅샷. 그룹 커밋은 사용하지 않는다(기존 at-most-once 유실 창 소멸).

### 3. 결정적 trade id + epoch

- `uuid4()` 폐지. `tid = {symbol}-{epoch}-{trade_seq}` — `trade_seq`는 책이 보유한 체결 카운터로 replay에서 동일하게 재현된다.
- `epoch`은 **fresh 부팅 시 1회 생성(unix ms)** 후 스냅샷에 포함 — 복원 경로에서는 스냅샷 값을 쓰므로 replay 결정성이 유지되고, fresh 시작마다 달라져 과거 DB tid와의 충돌(= BE가 진짜 신규 체결을 중복으로 오인하는 조용한 유실)을 차단한다.

### 4. 재방출 무해화 — BE의 기존 멱등성 활용 (at-least-once 방출)

ADR-014의 sourceKey 설계가 이 시나리오의 기반이다:

| outbound | 재수신 시 |
|---|---|
| TR | SettlementEvent `sourceKey=tid` unique → P2002 swallow (기존). **중복 시 TickerStats.applyTrade·fanout도 스킵하도록 가드 추가** (24h 통계 이중 집계·WS 중복 방송 방지) |
| OU | 절대값(st/eq/cqq) 재적용 → 동일 결과. dust 환불 `dust:{orderId}` dedup (기존). user-stream 중복 방송은 표시 전용이라 허용 |
| DPD | OrderBookCache에 **`u`(seq) 가드 추가**: u ≤ 현재값이면 drop. ADR-020이 미뤄둔 gap 감지의 일부를 겸한다 |

## Rationale

- 스냅샷-오프셋이 한 메시지에 원자로 묶이므로 "상태는 exactly-once, 방출은 at-least-once"가 되고, BE가 이미 at-least-once 소비자로 설계돼 있어(ADR-014) 접합부가 자연스럽다.
- 복구 시간 = 스냅샷 로드 + ≤30s분 메시지 재처리(수천 건, 1초 미만). futures LiquidationMonitor의 재시도 루프(terminal poll) 안에서 자연 수렴한다.
- 매칭 코어는 무수정 — 스냅샷은 직렬화 모듈과 main 루프(Lane 책임, ADR-013)에만 닿는다.

## Consequences

- 엔진이 빈 책으로 fresh 시작하면 `seq`가 리셋되어 BE OrderBookCache의 u 가드가 새 DPD를 drop한다 — **엔진 fresh 시작 시 BE도 재시작**하는 기존 운영 규칙이 유지된다(가드가 error 로그로 신호).
- tid 포맷이 uuid에서 `{symbol}-{epoch}-{seq}`로 바뀐다. Trade.id는 String이라 스키마 변경 없음. 기존 uuid 행과 공존.
- **스냅샷은 단일 루프 내 동기 실행 — 그 시간만큼 전 lane이 멈춘다(micro-STW).** 실측(2026-06-12, capture+json.dumps): 1k 주문 2.8ms / 10k 23ms·1.6MB / 50k 110ms / 100k 639ms. 완화 장치: 초기 due 시각 lane별 분산 + 호출당 1 lane 발행(일시정지 상한 = 책 1개) + 20ms 초과 시 slow 경고 로그. **규모 확대 시 escalation 사다리**: ① orjson/직접 직렬화(~5-10×) ② Kafka max.message.bytes 상향 또는 심볼별 chunking(10k 주문 ≈ 1.6MB로 기본 1MB 한도가 STW보다 먼저 깨짐) ③ hot ticker 인스턴스 분리(ADR-013 config 분할 — blast radius 축소) ④ fork 기반 COW 스냅샷(Redis BGSAVE 패턴 — 자식 프로세스가 직렬화·발행).
- 스냅샷 발행 실패(크기 초과 등)는 매칭을 멈추지 않는다 — error 로그 후 30s 뒤 재시도. 복구는 마지막 성공 스냅샷 + WAL replay로 여전히 정확하고, replay 구간만 길어진다. delivery 실패도 콜백으로 로그(조용한 유실 금지).
- 스냅샷 주기(30s)가 곧 replay 상한 — 주기 단축은 복구 시간과 트레이드오프 없이 상한만 줄인다(발행 비용 미미).
- 스냅샷 lag(마지막 발행 후 경과)은 운영 모니터링 대상이다.

## 관계
- [ADR-013](013-match-engine-lane-architecture.md): Lane이 스냅샷 단위·last_offset 보유 주체
- [ADR-014](014-async-settlement-via-event-log.md): sourceKey 멱등성이 재방출 무해화의 기반
- [ADR-020](020-orderbook-diff-and-be-reconstruction.md): DPD u 가드가 gap 감지의 일부를 선반영
- [ADR-021](021-stop-orders-be-trigger.md): 복구 재전송 중복 NO 리스크가 본 ADR의 결정적 복구로 완화
