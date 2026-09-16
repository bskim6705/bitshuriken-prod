# LIMIT STANDARD IOC – OB = EMPTY 시나리오

반대편 책이 비어 있을 때 LIMIT IOC taker.

## 시나리오

-   **BUY – 빈 책**
    -   Given: ask side 비어 있음. BUY IOC taker `price=100, qty=5`.
    -   Then:
        -   체결 없음. `updated_orders == [taker]`.
        -   taker status **CANCELED**(체결 0). rest 없음 — `contains` 거짓, `was_terminated` 참.
        -   `best_bid_price is None`, `best_ask_price is None` (GTC와 달리 bid가 생기지 않는다).

-   **SELL – 빈 책** — 대칭.
