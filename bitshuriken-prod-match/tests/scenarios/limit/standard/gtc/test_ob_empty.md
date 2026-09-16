# LIMIT STANDARD GTC – OB = EMPTY 시나리오

반대편 책이 **비어 있을 때**(`OB = EMPTY`) LIMIT GTC taker의 동작.

## 시나리오

-   **BUY – 빈 책**
    -   Given: ask side 비어 있음. BUY taker `price=100, qty=5`.
    -   When: `submit_new_order(book, taker)`.
    -   Then:
        -   체결 없음. `updated_orders == [taker]`.
        -   taker가 bid side `price=100`에 **OPEN**으로 rest. `contains(taker.id)` 참.
        -   `best_bid_price == 100`, `best_ask_price is None`.

-   **SELL – 빈 책**
    -   Given: bid side 비어 있음. SELL taker `price=100, qty=5`.
    -   Then: 체결 없음, taker가 ask side `price=100`에 OPEN으로 rest. `best_ask_price == 100`, `best_bid_price is None`.

이 두 케이스가 "매칭이 아예 시작되지 않는" 경로의 기준선이다 — 이후 파일들은 여기에 반대편 유동성을 더한다.
