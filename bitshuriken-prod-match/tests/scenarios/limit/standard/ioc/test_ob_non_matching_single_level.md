# LIMIT STANDARD IOC – OB = NON_MATCHING_SINGLE_LEVEL 시나리오

반대편 1레벨이 가격 조건을 못 맞추는 경우.

## 시나리오

-   **BUY, best ask보다 낮음 (매칭 없음)**
    -   Given: ask `110 / 3`. BUY IOC taker `price=100, qty=5`.
    -   Then:
        -   체결 없음(가격 한도). taker는 bid side에 **rest하지 않고** CANCELED로 종결.
        -   책은 **seq까지 포함해 무변경**(`book_state()` 비교) — 매칭도 add도 없었으므로.
        -   `best_ask == 110`, `best_bid is None`.

-   **SELL, best bid보다 높음 (매칭 없음)** — 대칭. `best_bid == 90`, `best_ask is None`.

GTC 대응 케이스는 taker가 rest했지만 IOC는 흔적 없이 사라진다는 점이 대비의 핵심이다.
