# LIMIT STANDARD GTC – OB = MATCHING_SINGLE_LEVEL_SINGLE_MAKER 시나리오

가격이 맞는 반대편 1레벨에 **maker 1개**가 있을 때. 수량 축(`QRel = smaller / equal / larger`)을
BUY/SELL 대칭으로 검증한다.

## 시나리오

-   **BUY vs SELL maker 1개 – taker가 maker보다 작음 (maker 부분 체결)**
    -   Given: ask `price=100, maker_qty=10`. BUY taker `price=100, taker_qty=4`.
    -   Then:
        -   체결 1건 `(taker, maker, 100, 4)`.
        -   maker 잔량 10 → 6, status PARTIAL, best ask 100 유지.
        -   taker FILLED(`remaining_qty == 0`), rest 없음(`contains` 거짓), `cumulative_quote_qty == 400`.
        -   `updated_orders`는 `[maker(PARTIAL), taker(FILLED)]` — maker 먼저, taker 마지막.

-   **SELL vs BUY maker 1개 – taker가 maker보다 작음** — 위와 대칭(bid side).

-   **BUY vs SELL maker 1개 – taker가 maker보다 큼 (잔여가 rest)**
    -   Given: ask `100 / 3`. BUY taker `100 / 5`.
    -   Then:
        -   체결 1건 `(taker, maker, 100, 3)`. maker FILLED, ask side에서 제거.
        -   taker 잔여 2가 bid side `100`에 **PARTIAL**로 rest. `best_ask is None`, `best_bid == 100`.
        -   레벨 100(bid)의 잔량 = 2.

-   **SELL vs BUY maker 1개 – taker가 maker보다 큼** — 대칭. 잔여 2가 ask `100`에 rest.

-   **BUY vs SELL maker 1개 – 정확히 교차 (taker_qty == maker_qty)**
    -   Given: ask `100 / 5`. BUY taker `100 / 5`.
    -   Then: 체결 1건 `(taker, maker, 100, 5)`. 양쪽 FILLED, rest 없음, best 둘 다 `None`.
        양쪽 id가 종결 기억(`was_terminated`)에 들어간다 — 중복 NO 재매칭 방어(관찰 #24)의 전제.

-   **SELL vs BUY maker 1개 – 정확히 교차** — 대칭.
