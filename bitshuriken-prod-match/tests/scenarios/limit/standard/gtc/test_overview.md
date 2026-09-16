# MatchEngine – LIMIT STANDARD GTC 테스트 설계 (overview)

`tests/scenarios/limit/standard/gtc/`가 표준 LIMIT GTC 주문(POST_ONLY 아님)을
`MatchEngine.submit_new_order`에 대해 어떻게 검증하는지 적는다.

-   `type = LIMIT` (`"L"`)
-   `time_in_force = GTC` (`"G"`)

초점은 가격-시간 우선 매칭의 정확성과, 잔여가 생겼을 때의 **rest 동작**이다.

---

## 1. 범위와 전제

-   **taker**: LIMIT GTC, 양의 정수 `price`/`orig_qty`(int × 10^8, step 정렬).
-   **maker**: 이미 책에 rest 중인 LIMIT GTC. maker의 타입·TIF는 매칭에 영향이 없다.
-   **OrderBook 불변식**(정렬·FIFO·index·seq·dirty)은 `tests/units/orderbook/`가 검증한다.
    여기서는 재검증하지 않고 다음만 단정한다:
    -   어떤 체결이 나는가 — `(taker_id, maker_id, price, qty)` 목록.
    -   taker가 rest하는가, 어느 가격에, 어떤 status로.
    -   기본 best 가격 기대치(교차 후 새 best).
-   **자전거래(STP)**: 이 엔진은 STP가 없다(ADR-007 §7 — maker/taker `user_id`가 같아도 정상 체결).
    원본 설계는 `stp_none/` 하위 폴더로 STP 축을 예약했지만, 쓰지 않는 차원을 위한 폴더는 만들지
    않는다(feedback-008). STP를 도입하면 그때 같은 자리에 모드별 폴더를 추가한다.

---

## 2. GTC LIMIT 매칭 의미론 (이 엔진)

`submit_new_order(book, taker)`:

1.  중복 id 가드(`contains` / `was_terminated`) → REJECTED. 이 문서 범위 밖(test_matcher.py).
2.  (POST_ONLY 아님, FOK 아님이므로 사전 체크 없음.)
3.  매칭 루프 `_match`: `_peek_best_maker`가 반대편 best 레벨의 **첫 주문(FIFO)**을 꺼낸다.
    -   BUY taker: asks를 낮은 가격부터. `best_ask > taker.price`면 중단(가격 한도).
    -   SELL taker: bids를 높은 가격부터. `best_bid < taker.price`면 중단.
    -   `fill_qty = min(maker.remaining_qty, taker.remaining_qty)`, 체결가는 **maker 가격**.
    -   `Trade(id = "{maker.id}-{taker.id}", …)`를 기록하고 양쪽 `executed_qty`/`cumulative_quote_qty`를 누적한다.
    -   maker 전량이면 `book.cancel(maker)` + FILLED + 종결 기억, 아니면 `book.partial_fill` + PARTIAL.
4.  잔여 처리:
    -   `remaining_qty == 0` → taker FILLED, 종결 기억. rest 없음.
    -   잔여 > 0이고 GTC → **`book.add(taker)`로 rest**. status는 체결이 있었으면 PARTIAL, 없었으면 OPEN.
5.  `MatchResult(trades, updated_orders)` 반환. `updated_orders`는 체결 순서대로 maker들, 마지막이 taker.

원본과의 차이: 원본은 체결과 책 갱신을 큐에 모았다가 마지막에 적용하고 `delta`(a/d/u) 목록을 돌려줬다.
이 엔진은 매칭 중 책을 즉시 갱신하고, 변경된 레벨을 `drain_dirty_levels()`로 따로 회수한다
(depth diff 발행 단위 = inbound 메시지 1건, ADR-020).

---

## 3. pairwise 시나리오 차원

-   **Side (S)**: `BUY`, `SELL` — 반대편이 asks인지 bids인지, 가격 비교 방향.
-   **OppositeBookState (OB)**:
    -   `EMPTY`: 반대편 유동성 없음.
    -   `NON_MATCHING_SINGLE_LEVEL`: 반대편 1레벨이 가격 조건을 **못 맞춤**(BUY: `best_ask > taker.price`).
    -   `MATCHING_SINGLE_LEVEL_SINGLE_MAKER`: 가격이 맞는 1레벨, maker 1개.
    -   `MATCHING_SINGLE_LEVEL_MULTI_MAKER`: 가격이 맞는 1레벨, maker 여러 개(FIFO).
    -   `MATCHING_MULTI_LEVEL`: 가격이 맞는 레벨이 여러 개.
-   **수량 관계 (QRel)** — 반대편 잔량 대비: `smaller` / `equal` / `larger`.

---

## 4. 시나리오 철학

파일 분할(각각 `.md` 설계 + `.py`):

-   `test_ob_empty` — `OB = EMPTY`
-   `test_ob_non_matching_single_level` — `OB = NON_MATCHING_SINGLE_LEVEL`
-   `test_ob_matching_single_level_single_maker`
-   `test_ob_matching_single_level_multi_maker`
-   `test_ob_matching_multi_level`

-   시나리오를 세 축으로 인수분해한다: **매칭 조건**(OB) × **수량 축**(QRel) × **가격 축**(레벨 수와 소비 순서).
-   단일 레벨 파일 4개는 **매칭 조건 + 수량 축**을 한 가격 레벨에서 책임진다 — BUY/SELL 대칭,
    `smaller/equal/larger`.
-   다중 레벨 파일은 **가격 축**을 책임진다 — 여러 레벨을 가격-시간 순으로 걷는지, 잔여가 **taker 가격**에
    (마지막 체결가가 아니라) rest하는지.
-   단일 레벨 파일이 수량 관계를 이미 덮으므로, 다중 레벨 파일은 "레벨을 2개 이상 실제로 통과"하는
    케이스만 담는다.

---

## 5. 범위 밖

-   POST_ONLY — `scenarios/limit/post_only/`.
-   IOC / FOK — `scenarios/limit/standard/{ioc,fok}/`.
-   MARKET — `scenarios/market/`.
-   무작위 시퀀스 불변식 — `tests/invariants/`.
