# LIMIT STANDARD FOK – OB = NON_MATCHING_SINGLE_LEVEL 시나리오

반대편 1레벨이 가격 조건을 못 맞추면 가격 한도 안 잔량이 0이므로 FOK는 **거부**된다.

## 시나리오

-   **BUY, best ask보다 낮음**
    -   Given: ask `110 / 3`. BUY FOK taker `price=100, qty=5`.
    -   Then: 사전 합산이 110 레벨에서 즉시 `break`(`110 > 100`) → 잔량 0 → REJECTED.
        체결 없음, 책 무변경, `best_ask == 110`, `best_bid is None`.

-   **SELL, best bid보다 높음** — 대칭. `best_bid == 90`.

IOC 대응 케이스와 status만 다르다(IOC는 CANCELED, FOK는 REJECTED) — 둘 다 책은 무변경이다.
