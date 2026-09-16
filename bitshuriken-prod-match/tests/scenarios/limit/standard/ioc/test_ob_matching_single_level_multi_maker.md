# LIMIT STANDARD IOC – OB = MATCHING_SINGLE_LEVEL_MULTI_MAKER 시나리오

가격이 맞는 1레벨에 maker 여러 개(`m1=2, m2=3, m3=4 @100`, 총 9). 수량 축 vs 레벨 총 잔량, FIFO 전제.

## 시나리오

-   **BUY taker – 총 잔량보다 작음 (5)** — FIFO로 m1(2), m2(3) 소진, m3 무접촉(잔량 4). taker FILLED, 잔여 없음 → IOC 종결 경로 없음.
-   **BUY taker – 총 잔량과 같음 (9)** — m1, m2, m3 전부 소진, 레벨 소멸. taker FILLED.
-   **BUY taker – 총 잔량보다 큼 (11)** — 세 maker 소진(합 9), 잔여 2는 **rest하지 않고 PARTIAL로 종결**.
    `best_ask is None`, `best_bid is None`, `was_terminated` 참.
-   **SELL taker – 작음 / 같음 / 큼** — 대칭.

GTC의 "잔여가 bid/ask로 rest" 케이스가 여기서는 "책이 양쪽 다 비어 있다"로 바뀐다.
