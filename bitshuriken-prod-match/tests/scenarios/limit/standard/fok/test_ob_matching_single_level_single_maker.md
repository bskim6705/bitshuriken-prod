# LIMIT STANDARD FOK – OB = MATCHING_SINGLE_LEVEL_SINGLE_MAKER 시나리오

가격이 맞는 1레벨에 maker 1개. IOC와의 핵심 차이:

-   잔량이 taker를 **채우기에 충분**하면(`QRel = smaller / equal`) FOK는 **수락되어 전량 체결**(rest 없음, 거부 없음).
-   **부족**하면(`QRel = larger`) FOK는 **거부** — 부분 체결이 보존되지 않고 rest도 없다.

## 시나리오

-   **BUY vs SELL maker 1개 – taker가 작음 (maker 부분 체결, FOK 성공)**
    -   ask `100 / 10`, BUY FOK `100 / 4` → 체결 `(taker, maker, 100, 4)`, maker 잔량 6, taker FILLED.
-   **SELL vs BUY maker 1개 – taker가 작음** — 대칭.
-   **BUY vs SELL maker 1개 – taker가 큼 (FOK 거부, 잔량 부족)**
    -   ask `100 / 3`, BUY FOK `100 / 5` → 사전 합산 3 < 5 → REJECTED.
        **maker는 무접촉**(잔량 3, OPEN), 책 무변경, bid side 비어 있음.
    -   IOC였다면 3이 체결되고 잔여 2가 종결됐을 자리다 — FOK는 그 3조차 체결하지 않는다.
-   **SELL vs BUY maker 1개 – taker가 큼** — 대칭.
-   **BUY vs SELL maker 1개 – 정확히 교차** — 5 = 5 → 전량 체결, 양쪽 FILLED, best 둘 다 `None`.
-   **SELL vs BUY maker 1개 – 정확히 교차** — 대칭.
