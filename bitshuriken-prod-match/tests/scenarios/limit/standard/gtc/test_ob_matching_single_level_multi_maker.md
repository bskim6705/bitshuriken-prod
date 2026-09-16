# LIMIT STANDARD GTC – OB = MATCHING_SINGLE_LEVEL_MULTI_MAKER 시나리오

가격이 맞는 반대편 1레벨에 **maker 여러 개**가 있을 때. 초점은 **수량 축 vs 그 레벨의 총 잔량**이고,
레벨 안에서는 FIFO를 전제한다.

-   BUY/SELL 대칭.
-   `QRel = smaller / equal / larger`는 **maker 수량 합**에 대한 관계.

공통 세팅: 가격 100에 `m1=2`(가장 먼저), `m2=3`, `m3=4` (총 잔량 9).

## 시나리오

-   **BUY taker – 총 잔량보다 작음 (마지막 maker는 무접촉, rest 없음)**
    -   BUY taker `100 / 5`.
    -   Then: FIFO 순서로 `(taker, m1, 100, 2)`, `(taker, m2, 100, 3)`. m1·m2 FILLED, **m3 무접촉**(잔량 4, OPEN).
        레벨에 `[m3]`만 남는다. taker FILLED, rest 없음.
    -   원본 명세는 "마지막 maker 부분 체결"이라 적었지만 5 = 2 + 3이라 m3는 건드리지 않는다.
        FIFO가 맞다면 m3가 아니라 m1·m2가 소진돼야 한다는 것이 이 케이스의 요점이다.

-   **BUY taker – 총 잔량과 같음 (모든 maker 소진, rest 없음)**
    -   BUY taker `100 / 9`.
    -   Then: `[m1, m2, m3]` 순으로 `[2, 3, 4]` 체결. 레벨 100 소멸(`best_ask is None`). taker FILLED.

-   **BUY taker – 총 잔량보다 큼 (잔여가 bid로 rest)**
    -   BUY taker `100 / 11`.
    -   Then: 세 maker 전부 소진(체결 합 9). 잔여 2가 bid side `100`에 PARTIAL로 rest —
        `best_bid == 100`, 레벨 `[taker]`.

-   **SELL taker – 작음 / 같음 / 큼** — bid side에 같은 세팅, 대칭. 잔여는 ask side `100`에 rest.
