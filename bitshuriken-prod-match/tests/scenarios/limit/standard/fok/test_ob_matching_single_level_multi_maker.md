# LIMIT STANDARD FOK – OB = MATCHING_SINGLE_LEVEL_MULTI_MAKER 시나리오

가격이 맞는 1레벨에 maker 여러 개(`m1=2, m2=3, m3=4 @100`, 총 9). 수량 축 vs 레벨 총 잔량.

-   총 잔량이 충분(`smaller / equal`) → 수락, 전량 체결(FIFO), rest 없음.
-   부족(`larger`) → REJECTED, 책 무변경 — **FIFO 앞쪽 maker조차 건드리지 않는다**.

## 시나리오

-   **BUY taker – 작음 (5)** — m1(2), m2(3) FIFO 체결, m3 무접촉. taker FILLED.
-   **BUY taker – 같음 (9)** — 세 maker 전부 소진, 레벨 소멸. FOK 조건 정확히 충족.
-   **BUY taker – 큼 (11)** — 사전 합산 9 < 11 → REJECTED. 레벨은 `[m1, m2, m3]` 그대로.
-   **SELL taker – 작음 / 같음 / 큼** — 대칭.
