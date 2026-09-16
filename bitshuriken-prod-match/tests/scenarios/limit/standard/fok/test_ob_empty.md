# LIMIT STANDARD FOK – OB = EMPTY 시나리오

반대편이 비어 있으면 FOK taker는 **전혀 채울 수 없다** → 거부. 부분 체결도 rest도 없다.

## 시나리오

-   **BUY – 빈 책**
    -   Given: ask side 비어 있음. BUY FOK taker `price=100, qty=5`.
    -   Then: 체결 없음, `status == REJECTED`, `updated_orders == [taker]`, `executed_qty == 0`,
        책 무변경(`book_state()` seq 포함 동일), `contains` 거짓, best 둘 다 `None`.

-   **SELL – 빈 책** — 대칭.
