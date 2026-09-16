# ADR-007: 매칭엔진 핵심 기능 — Maker/Taker, Sequence, OrderType, TIF

## Status
Accepted
> **[2026-09-16 배너]** §2 'seq는 publish 안 함' → 지금은 `DepthDiffMsg.u`로 publish한다. §5 `E`(EXPIRED)는 ADR-026대로 엔진 `P` → BE가 EXPIRED 매핑. 본문에 없는 후속: 중복 id REJECTED + 종결 id FIFO 50k(관찰 #24), quote-driven MARKET BUY(잔여 quote가 1 step 미만이면 종료, dust는 BE 환불), FOK 사전 유동성 합산. §7 STP 없음은 유지.

## Context
매칭 알고리즘을 처음 구현할 때, 나중에 추가하면 매칭 코어를 다시 써야 하는 기능들을 한 번에 흡수해야 한다. 또한 어떤 OrderType과 TimeInForce를 매칭엔진이 직접 처리할지 정해야 한다.

## Decision

### 1. Maker / Taker 구분
- **Taker** = 방금 들어온 주문 (`submit_new_order`의 인자)
- **Maker** = 호가창에 이미 있던 주문
- 매칭 시점에만 알 수 있는 정보. Trade 객체에 maker/taker 양쪽의 `order_id`, `user_id`를 모두 기록한다.
- Trade 데이터 모델은 `maker_order_id`, `taker_order_id`, `maker_user_id`, `taker_user_id`, `taker_side` 필드를 갖는다.

### 2. OrderBook Sequence Number
- `OrderBook.seq: int = 0` 필드. `add` / `cancel` / `partial_fill` 매번 +1.
- 향후 L2/L3 delta publish 시 클라이언트의 누락 감지에 사용 (현재는 publish 안 함, 카운터만 유지).

### 3. 지원 OrderType
- `LIMIT` — 가격 매칭 + 잔여는 호가창에 rest
- `MARKET` — 가격 무시, 즉시 매칭만, 잔여는 cancel
- `POST_ONLY` — 매칭 가능하면 즉시 REJECTED. add 직전 best opposite price 체크
- **미지원**: `ICEBERG` (데이터 모델 침투, 추후 결정)

### 4. 지원 TimeInForce
- `GTC` (Good Till Canceled) — 기본. 잔여를 호가창에 rest
- `IOC` (Immediate Or Cancel) — 잔여를 cancel
- `FOK` (Fill Or Kill) — 사전에 호가창 유동성을 합산하여 부족하면 REJECTED

### 5. OrderStatus 확장
- `NEW` — BE에서 매칭엔진 도착 전 (기존 `PENDING`을 rename)
- `OPEN` — 호가창에 rest 중
- `PARTIAL` — 부분 체결 상태로 호가창에 rest 중
- `FILLED` — 완전 체결
- `CANCELED` — 사용자 요청 취소
- `REJECTED` — POST_ONLY/FOK 등 사전 거부
- `EXPIRED` — STP에 의해 종료 (현재 미사용, 향후)

`PENDING`/`PARTIAL`이 모두 P로 시작하는 혼동을 피하기 위해 `PENDING` → `NEW` rename.

### 6. 매칭 알고리즘
- **가격-시간 우선순위 (price-time priority)**.
- 같은 가격대 안에서는 FIFO (`OrderedDict`로 유지).
- 체결 가격은 **maker price 우선** (taker가 가격을 양보).

### 7. Self-Trade 처리 (현재)
- 매칭엔진은 user_id를 무시하고 매칭한다. 같은 유저의 BUY와 SELL이 만나면 정상적으로 trade가 발생한다.
- STP(Self-Trade Prevention)는 별도 ADR로 추후 추가. 추가 시 매칭 루프 안 한 곳에 분기만 들어간다 (구조적으로 비파괴).

## Rationale
- **Maker/Taker는 매칭 시점에만 결정 가능**: 나중에 backfill 불가능. 처음부터 정확히 기록.
- **seq는 매우 가벼움**: 카운터 한 번 증가. 나중에 publish 기능 추가할 때 미리 깔려 있어야 함.
- **OrderType / TIF 분기는 코드량 적음**: 처음부터 넣어두면 향후 확장이 쉽다.
- **STP 제외**: STP는 모드별 동작이 복잡하고 FOK 사전 체크와 상호작용. 지금 단계에선 self-trade를 그냥 허용하는 게 단순하고 정확하다.

## Consequences
- 매칭엔진 결과(`MatchResult`)는 `trades: list[Trade]` + `updated_orders: list[Order]`를 반환한다.
- BE는 `match.trade`, `match.order-update` 토픽을 consume하여 DB에 trade 생성 + order status 업데이트 + wallet 잔고 변동을 트랜잭션으로 처리해야 한다 (다음 단계).
- ICEBERG 미지원으로 호가창 publish는 단순하다 (visible vs hidden 구분 없음).
- STP 추가 시 ADR-007a 또는 ADR-008로 별도 기록.
