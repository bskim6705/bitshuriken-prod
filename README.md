# bitshuriken-prod-match

매칭 엔진 서비스. Kafka로부터 주문을 받아 가격-시간 우선순위로 매칭하고, 체결 결과를 Kafka로 publish한다.

코드는 spot/futures 공용이며 **인스턴스를 분리**해서 띄운다. 인스턴스가 담당할 ticker 목록은 `MATCH_CONFIG_PATH`가 가리키는 config 파일이 결정한다.

## Module structure

```
bitshuriken-prod-match/
├── main.py             # 엔트리포인트: config → Lane 생성, symbol(key) 라우팅 루프
├── config/
│   ├── tickers-spot.json     # spot 인스턴스용 ticker 목록
│   └── tickers-futures.json  # futures 인스턴스용 ticker 목록
├── engine/
│   ├── order.py        # Order dataclass + enum (Type/Side/Status/TimeInForce)
│   ├── orderbook.py    # OrderBook (가격-시간 우선 호가창 + depth diff 추적)
│   ├── matcher.py      # MatchEngine (매칭 알고리즘, 상태 없음)
│   └── trade.py        # Trade dataclass
├── messaging/
│   ├── consumer.py     # Kafka consumer 래퍼
│   ├── producer.py     # Kafka producer 래퍼
│   └── topics.py       # 토픽 이름 / op 코드 상수
├── schemas/
│   ├── messages.py     # 축약 필드 메시지 dataclass (직렬화/역직렬화)
│   └── snapshot.py     # Lane 스냅샷 직렬화/복원 (match.{market}.state)
└── tests/              # pytest (Kafka 불필요, 엔진 직접 호출)
```

### Responsibilities

- **Order** — 단일 주문. price/qty는 모두 int (`* 10^8`). `orig_qty`(base) 또는 `orig_quote_qty`(quote) 중 하나로 구동.
- **OrderBook** — 한 ticker의 bid/ask 호가창. add / cancel / partial_fill + depth diff용 dirty level·seq 추적.
- **MatchEngine** — OrderBook을 인자로 받아 매칭만 수행 (POST_ONLY/FOK 사전 체크, 매칭 루프, 잔여 종결).
- **Lane** (main.py) — 1 ticker에 대응하는 토픽 입출력 + OrderBook 묶음. 1 인스턴스 N ticker.

## Config

```json
{
  "tickers": [
    {
      "market": "spot",
      "symbol": "BTCUSDT",
      "partition": 0,
      "pricePrecision": 2,
      "qtyPrecision": 5
    }
  ]
}
```

- `market` → 토픽 결정: `match.{market}.{in|out|book}`
- `partition` → P개 고정 버킷 중 하나 (FNV-1a(symbol)%P, 여러 ticker가 한 파티션 공유)
- `pricePrecision`/`qtyPrecision` → `price_tick = 10^(8-pricePrecision)`, `qty_step = 10^(8-qtyPrecision)`

## Precision

- **매칭엔진 내부**: 모든 가격/수량을 **int**로만 다룬다 (`* 10^8`). 부동소수점 오차를 원천 차단. 나눗셈은 항상 floor.
- **외부 메시지**: 숫자 값을 **string**으로 직렬화 (JSON safe integer 한계 회피).
- **변환**: 수신 시 `int(msg["p"])`, 송신 시 `str(order.price)`.

| 표시값      | 내부 (int)            | 메시지 (str)            |
| ----------- | --------------------- | ----------------------- |
| 50000.00    | 5000000000000         | "5000000000000"         |
| 0.10000000  | 10000000              | "10000000"              |

## Message format

축약 필드명 + `op` 코드로 종류를 식별한다. market은 토픽 이름이 알고 있으므로 본문에 없다.

### Inbound (`match.{market}.in`)

**NO — 신규 주문**

| 필드 | 의미 | 값 |
| ---- | ---- | --- |
| op   | op 코드 | "NO" |
| id   | order id | uuid |
| u    | user id | uuid |
| s    | symbol | "BTCUSDT" |
| t    | type | "L" (LIMIT) / "M" (MARKET) / "PO" (POST_ONLY) |
| sd   | side | "B" / "S" |
| tif  | time in force | "G" (GTC) / "I" (IOC) / "F" (FOK) |
| p    | price (int * 10^8 str) | MARKET이면 "0" |
| oq   | origQty (base) | quote-driven이면 "0" |
| oqq  | origQuoteQty (quote) | base-driven이면 "0" |

MARKET BUY 구동 방식: **spot은 quote-driven** (`oqq` > 0, `oq`="0"), **futures는 base-driven** (`oq` > 0, `oqq`="0" — MARKET SELL과 동일 경로).

**CO — 주문 취소**: `{op: "CO", id, u, s}`

### Outbound (`match.{market}.out`)

**TR — 체결**

| 필드 | 의미 |
| ---- | ---- |
| tid  | trade id |
| s    | symbol |
| mo / to | maker / taker order id |
| mu / tu | maker / taker user id |
| sd   | taker side |
| p / q | price / qty (int * 10^8 str) |
| ts   | epoch ms |

**OU — 주문 상태 변경**: `{op: "OU", id, u, st, eq, cqq, ts}`
- st: "N"/"O"/"P"/"F"/"C"/"R"/"E", eq: executedQty, cqq: cumulativeQuoteQty
- MARKET/IOC 부분체결 종결의 최종 st는 "P" — 잔여는 엔진이 버리고 추가 OU 없음 (EXPIRED 매핑은 BE 책임)

### Outbound (`match.{market}.book`)

**DPD — orderbook level delta**: `{op: "DPD", s, ts, u, b, a}`
- u: OrderBook seq (batch 적용 후), b/a: `[[priceIntStr, qtyIntStr], ...]`, qty "0"은 level 제거

## State recovery

inbound 토픽(`match.{market}.in`)이 WAL이고 매칭은 결정적이다(trade id = `{symbol}-{epoch}-{trade_seq}`). 엔진은 lane이 dirty이고 마지막 스냅샷 후 30s가 지나면 poll 타임아웃 heartbeat에서 book 상태+마지막 처리 inbound offset을 `match.{market}.state`(log-compacted, key=symbol, lane과 같은 partition)에 1메시지로 발행한다. 부팅 시 state 토픽에서 lane별 마지막 스냅샷을 복원하고 inbound를 `offset+1`부터 일반 처리한다 — replay 구간의 outbound는 그대로 재방출되며 BE가 sourceKey로 멱등 처리한다. 스냅샷이 없으면 빈 책 + 새 epoch으로 inbound 최신(latest)부터 시작한다(과거 일부만 replay하면 빈 책에 가짜 매칭이 생기므로).

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Env

```
KAFKA_BROKER=localhost:5113
MATCH_CONFIG_PATH=./config/tickers-spot.json
```

둘 다 필수. `.env` 파일 지원 (`python-dotenv`).

## Run

spot/futures는 별도 인스턴스로 실행한다.

```bash
source venv/bin/activate

# spot 인스턴스
MATCH_CONFIG_PATH=./config/tickers-spot.json python main.py

# futures 인스턴스 (별도 터미널)
MATCH_CONFIG_PATH=./config/tickers-futures.json python main.py
```

## Test

```bash
source venv/bin/activate
pytest
```
