# ADR-005: 매칭엔진 모듈 구조 및 메시지 필드 축약

## Status
Accepted
> **[2026-09-16 배너]** 모듈 구성·필드 축약 표·토픽 예시가 낡았다 — 실제는 `engine/{order,orderbook,matcher,lane,trade}`, `messaging/{topics,control,outbound,snapshot_store}`, `schemas/{order_codec,snapshot}`. MatchEngine은 **무상태**(`submit_new_order(book, taker)`, 라우팅은 `main.py`, publish는 `OutboundPublisher`; ADR-013). 필드는 `oq/oqq/eq/cqq`(ADR-009), `m`(market)은 없음(토픽이 결정). 토픽은 `match.{market}.{in|out|book|state|control}` + `op`(ADR-010).

## Context
Python 매칭엔진을 처음부터 모듈화된 구조로 설계한다. 또한 매칭엔진과 주고받는 메시지(Kafka, WebSocket)는 거래소 특성상 매우 높은 빈도로 발생하므로, 필드명 축약으로 페이로드 크기를 최소화한다.

## Decision

### 모듈 구조

```
bitshuriken-v2-match/
├── main.py                 # 엔트리포인트 (consumer 루프)
├── engine/
│   ├── __init__.py
│   ├── order.py            # Order 클래스, enum (Side, Type, Status)
│   ├── orderbook.py        # OrderBook 클래스 (bids/asks, 가격-시간 우선순위)
│   └── matcher.py          # MatchEngine — orderbook 관리 + 매칭 실행
├── messaging/
│   ├── __init__.py
│   ├── consumer.py         # Kafka consumer 래퍼
│   └── producer.py         # Kafka producer 래퍼
└── schemas/
    ├── __init__.py
    └── messages.py         # 축약 필드 메시지 dataclass
```

### 클래스 책임

- **Order** — 단일 주문 표현 (id, user, side, price, amount, filled, status, ts). price/amount/filled는 모두 int (소수점 8자리 * 10^8 형태).
- **OrderBook** — 한 ticker(symbol+market)의 bid/ask 양쪽 호가창 관리. add/cancel/match 메서드 제공.
- **MatchEngine** — 여러 OrderBook을 ticker별로 보유. Kafka 메시지를 받아 해당 OrderBook에 라우팅하고 체결 결과를 producer로 publish.

### 정밀도 처리

- **매칭엔진 내부**: 모든 price/amount/filled는 **int**로만 다룬다 (`* 10 ** 8` 형태). float/Decimal로 변환하지 않는다.
- **외부 (Kafka 메시지)**: 모든 숫자 값(price, amount, filled, ts 제외)은 **string**으로 직렬화한다. 예: `"p": "5000000000000"`.
- **변환 시점**: 메시지 수신 시 `int(msg["p"])`, 송신 시 `str(order.price)`. 한 메시지당 변환 오버헤드는 무시 가능 수준.

#### 왜 string인가?

`* 10 ** 8` 정수 그대로 보내면 JSON safe integer 한계(2^53-1 ≈ 9 × 10^15)에 부딪힌다.

- max 표현 가능값 = 9 × 10^15 / 10^8 = 9 × 10^7 (≈ 9천만)
- DOGE/SHIB 같은 저가 코인의 amount, 또는 선물 notional 등에서 쉽게 오버플로
- BE는 Node.js이므로 `JSON.parse`가 native number를 사용 → 2^53 초과 시 정밀도 손실

string 직렬화의 비용은 미미하지만(따옴표 2byte), 안전성은 결정적이다.

### 메시지 필드 축약 규칙

거래소는 초당 수만 건의 메시지를 주고받기 때문에, 필드명 1byte 절약도 누적되면 큰 차이가 된다. 모든 Kafka/WebSocket 메시지는 축약 필드를 사용한다.

**공통 약어:**

| 축약 | 의미       | 타입 (메시지) | 예시 값                     |
| ---- | ---------- | ------------- | --------------------------- |
| id   | order id   | str           | uuid                        |
| u    | user id    | str           | uuid                        |
| s    | symbol     | str           | "BTCUSDT"                   |
| m    | market     | str           | "S" (SPOT) / "F" (FUTURES)  |
| t    | type       | str           | "L" (LIMIT) / "M" (MARKET)  |
| sd   | side       | str           | "B" (BUY) / "S" (SELL)      |
| p    | price      | str           | "5000000000000" (int * 10^8) |
| a    | amount     | str           | "10000000"                  |
| f    | filled     | str           | "5000000"                   |
| st   | status     | str           | "P" / "O" / "F" / "C"       |
| ts   | timestamp  | int           | epoch ms                    |

**Trade 메시지 추가 약어:**

| 축약 | 의미             |
| ---- | ---------------- |
| tid  | trade id         |
| mo   | maker order id   |
| to   | taker order id   |
| mu   | maker user id    |
| tu   | taker user id    |

**예시 메시지:**

`match.new-order` (BE → match)
```json
{ "id": "uuid", "u": "uuid", "s": "BTCUSDT", "m": "S", "t": "L", "sd": "B", "p": "5000000000000", "a": "10000000" }
```

`match.trade` (match → BE)
```json
{ "tid": "uuid", "s": "BTCUSDT", "m": "S", "mo": "uuid", "to": "uuid", "mu": "uuid", "tu": "uuid", "sd": "B", "p": "5000000000000", "a": "5000000", "ts": 1733527200000 }
```

## Rationale

- **모듈 분리**: engine(도메인 로직), messaging(I/O), schemas(데이터 형태)를 처음부터 나누면 단위 테스트가 쉽고 메시징 백엔드 교체(Kafka → NATS 등)도 용이.
- **OrderBook을 별도 클래스**로 두면 ticker별로 인스턴스를 격리할 수 있어 멀티 ticker 지원이 자연스러움.
- **필드 축약**: 거래소는 호가/체결 스트림이 초당 수만 건. 필드명을 평균 5bytes에서 1~2bytes로 줄이면 누적 절감 효과가 크다.
- **enum 값도 축약**(`SPOT` → `S`): 가독성보다 페이로드 크기를 우선.
- **int 일관 (내부)**: 부동소수점 오차 가능성 0, 비교/연산 단순.
- **string 직렬화 (메시지)**: JSON safe int 한계로부터 안전. 변환 오버헤드는 무시 가능.
- **공식 문서화**(이 ADR)를 통해 BE↔match 양쪽 코드가 같은 약어와 직렬화 규칙을 쓰도록 강제.

## Consequences
- BE도 Kafka 메시지를 보낼 때/받을 때 이 약어 규약과 string 직렬화를 따라야 한다 (DTO와 별개의 메시지 직렬화 레이어 필요).
- BE는 Decimal ↔ string ↔ int 변환 레이어가 필요하다.
- Match engine 내부에서는 풀네임 클래스 속성을 쓰되, 메시지 직렬화/역직렬화 시점에만 축약 필드 + string 변환을 적용한다 (코드 가독성 보호).
- 새 필드 추가 시 이 ADR을 업데이트하여 전체 약어 일관성을 유지한다.
