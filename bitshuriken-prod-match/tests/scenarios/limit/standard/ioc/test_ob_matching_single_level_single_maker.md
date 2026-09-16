# LIMIT STANDARD IOC – OB = MATCHING_SINGLE_LEVEL_SINGLE_MAKER 시나리오

가격이 맞는 1레벨에 maker 1개.

## 시나리오

-   **BUY vs SELL maker 1개 – taker가 작음 (maker 부분 체결)**
    -   Given: ask `100 / 10`. BUY IOC taker `100 / 4`.
    -   Then: 체결 `(taker, maker, 100, 4)`. maker 잔량 6(PARTIAL), best ask 100 유지. taker FILLED, rest 없음.
        잔여가 없으므로 IOC 종결 경로는 타지 않는다(GTC와 결과 동일).

-   **SELL vs BUY maker 1개 – taker가 작음** — 대칭.

-   **BUY vs SELL maker 1개 – taker가 큼 (IOC 잔여 종결)**
    -   Given: ask `100 / 3`. BUY IOC taker `100 / 5`.
    -   Then:
        -   체결 `(taker, maker, 100, 3)`. maker FILLED, ask side에서 제거.
        -   taker `executed_qty 3`, `remaining_qty 2` — 잔여 2는 **rest하지 않고** status **PARTIAL**로 종결.
        -   `best_ask is None`, **`best_bid is None`**(GTC였다면 100에 bid가 생겼을 자리), `was_terminated` 참.

-   **SELL vs BUY maker 1개 – taker가 큼** — 대칭. 잔여 2가 ask로 rest하지 않는다.

-   **BUY vs SELL maker 1개 – 정확히 교차** — 체결 1건(5), 양쪽 FILLED, best 둘 다 `None`.
-   **SELL vs BUY maker 1개 – 정확히 교차** — 대칭.
