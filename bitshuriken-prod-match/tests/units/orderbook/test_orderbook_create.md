# OrderBook – `add` 테스트 설계

`tests/units/orderbook/test_orderbook_create.py`가 `OrderBook.add`의 어떤 동작을 어떤 근거로
검증하는지 적는다. 원본 설계(wasd/matching-engine `test_orderbook_create.md`)의 두 층 구조를
따르되, 이 엔진의 계약에 맞게 방어 층을 줄였다.

두 층:

-   **방어 테스트**: 계약 위반 입력이 거부되고 내부 상태를 건드리지 않는다.
-   **도메인 유효 pairwise 테스트**: 유효 입력 공간을 작은 차원 집합으로 나눠 `add`의 의도된
    동작을 검증한다.

---

## 방어 테스트

### 계약 전제

-   매칭엔진(`MatchEngine`) 계층:
    -   `add`는 **매칭이 끝난 뒤에만** 호출된다 (`submit_new_order` 잔여 처리 경로).
    -   중복 id는 `submit_new_order`가 `contains`/`was_terminated`로 먼저 걸러 REJECTED로 통지한다.
-   OrderBook 계층:
    -   위 계약을 전제로 동작하되, 자기 자료구조를 깨뜨리는 입력 하나(중복 id)는 직접 방어한다.

### 왜 원본보다 방어 케이스가 적은가

원본 엔진의 `add_order`는 타입·범위·심볼·주문타입·TIF·side·교차 삽입을 전부 검사했다. 이 엔진은
**"검증기가 아니라 매칭기"**다 — 가격 정밀도·수량 step·minNotional·심볼 유효성은 BE 검증 계층
소관이고(`price_tick`은 엔진에서 사용되지 않는다), 엔진 입력은 Kafka 메시지 역직렬화(`OrderCodec`)를
거친 정수다. 방어 코드를 이중으로 두면 매칭 핫패스에 비용만 붙는다.

교차 삽입(BUY ≥ best_ask / SELL ≤ best_bid) 방어도 없다. 이 엔진에서 `add`는 매칭 루프가
"더 이상 매칭할 maker가 없다"고 판정한 뒤에만 불리므로, 교차 삽입이 생긴다면 그것은 매칭 로직 버그다.
그 불변식은 자료구조 층이 아니라 결과 층에서 검증한다 — `tests/invariants/`의 무작위 시퀀스가
매 연산 후 `best_bid < best_ask`를 단정한다.

### 다루는 방어 케이스

-   **중복 order id**: 이미 `_index`에 있는 id로 `add` → `ValueError("duplicate order id")`.
    책은 seq까지 포함해 무변경이어야 하고(`book_state()` 비교), 원본 주문은 정상 취소 가능해야 한다.

---

## 도메인 유효 pairwise 테스트

### 목표

유효 입력의 모든 조합에서 `add`가 자료구조 정합(가격 레벨·index·seq·dirty)을 유지하는지를
"Case 1/2/3" 선형 분기가 아니라 차원의 pairwise 조합으로 검증한다.

### 입력 차원

-   **Side (S)**: `BUY`, `SELL` — 어느 쪽 맵(`_bids`/`_asks`)을 만지고 가격 정렬 방향이 어느 쪽인가.
-   **BookNonEmptyBefore (P)**: `True`/`False` — 그 side에 이미 rest 레벨이 있는가(best 가격이 정의되는가).
-   **RelativePricePosition (Rel)**: `better`/`equal`/`worse` — 새 주문 가격이 현재 best 대비 어디인가.
    -   BUY: `better` = 더 높은 가격, SELL: `better` = 더 낮은 가격.
    -   실현 가능 조합: `P=False`면 `better`만 의미가 있고, `P=True`면 셋 다 의미가 있다.

### 기대 동작 (모든 유효 삽입에 공통)

-   `(side, price)` 레벨이 존재하고, 그 `OrderedDict`에 이 id가 **FIFO 끝에** 추가된다.
-   `_index[id] == (side, price)`, `contains(id)`가 참.
-   side 맵은 가격 정렬을 유지한다 (`get_bid_levels` 내림차순, `get_ask_levels` 오름차순).
-   `Rel=better`면 best가 새 가격으로, `equal`/`worse`면 best 불변.
-   **이 엔진 고유**: `seq`가 정확히 1 증가하고, `(side, price)`가 dirty 레벨로 기록되어
    `drain_dirty_levels()`가 그 레벨의 현재 합산 잔량을 돌려준다 (depth diff 발행의 원천).

### 시나리오 집합

| Scenario | S    | P     | Rel    | 설명 |
| -------- | ---- | ----- | ------ | ---- |
| S1 | BUY  | False | better | 빈 bid side에 새 레벨 = best bid |
| S2 | SELL | False | better | 빈 ask side에 새 레벨 = best ask |
| S3 | BUY  | True  | equal  | 기존 best bid 레벨 FIFO 뒤에 추가 |
| S4 | SELL | True  | equal  | 기존 best ask 레벨 FIFO 뒤에 추가 |
| S5 | BUY  | True  | better | 기존 best 위에 새 best 레벨 |
| S6 | SELL | True  | better | 기존 best 아래에 새 best 레벨 |
| S7 | BUY  | True  | worse  | best 불변, 하위 레벨 FIFO 뒤에 추가 |
| S8 | SELL | True  | worse  | best 불변, 상위 레벨 FIFO 뒤에 추가 |

`(S, P, Rel)`의 모든 값 쌍이 적어도 한 시나리오에 등장한다.
