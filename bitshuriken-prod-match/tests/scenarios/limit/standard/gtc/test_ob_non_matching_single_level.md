# LIMIT STANDARD GTC – OB = NON_MATCHING_SINGLE_LEVEL 시나리오

반대편에 정확히 1레벨이 있지만 **가격 조건을 못 맞추는** 경우(`OB = NON_MATCHING_SINGLE_LEVEL`).

## 시나리오

-   **BUY, best ask보다 낮은 가격 (매칭 없음)**
    -   Given: ask 1레벨 `price=110, qty=3`. BUY taker `price=100`(`< best_ask`), qty 5.
    -   Then:
        -   체결 없음 (가격 한도 — `_peek_best_maker`가 `best_ask > taker.price`에서 None).
        -   taker가 bid side `100`에 OPEN으로 rest.
        -   ask side 무변경: `best_ask == 110`, 레벨 잔량 3 그대로.

-   **SELL, best bid보다 높은 가격 (매칭 없음)**
    -   Given: bid 1레벨 `price=90, qty=3`. SELL taker `price=100`(`> best_bid`), qty 5.
    -   Then: 체결 없음, taker가 ask side `100`에 rest, `best_bid == 90` 무변경, `best_ask == 100`.

핵심은 "반대편 유동성이 있어도 가격이 안 맞으면 EMPTY와 동일하게 rest한다"는 것과, 반대편이 **전혀**
건드려지지 않는다는 것이다.
