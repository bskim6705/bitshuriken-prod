# MatchEngine – LIMIT POST_ONLY 테스트 설계

`tests/scenarios/limit/post_only/test_post_only.py`가 POST_ONLY 주문을 `MatchEngine.submit_new_order`에
대해 어떻게 검증하는지 적는다.

범위:

-   taker: `type = POST_ONLY` (`"PO"`). 이 엔진은 POST_ONLY를 별도 **주문 타입**으로 둔다
    (원본은 LIMIT + `post_only=True` 플래그였다). 나머지 의미론은 같다.
    -   TIF: 주로 `GTC`(rest 동작). `IOC`/`FOK` 조합도 허용되며 rest가 없다:
        -   POST_ONLY + IOC: 즉시 CANCELED(체결 0).
        -   POST_ONLY + FOK: 유동성 검사에서 REJECTED.
-   maker: 이미 rest 중인 LIMIT GTC. maker의 타입은 무관.

초점:

-   반대편 best 가격에 대한 **POST_ONLY 사전 체크**의 정확성.
-   POST_ONLY 주문에서 **체결이 절대 나지 않는다**는 것.
-   "would trade"로 거부될 때 **책이 무변경**이라는 것.
-   거부되지 않으면 일반 LIMIT GTC 삽입과 **동일하게 rest**한다는 것.

---

## 1. 의미론 (이 엔진)

`submit_new_order` 순서: 중복 id 가드 → **POST_ONLY 사전 체크 `_would_cross`** → FOK 사전 체크 → 매칭 루프 → 잔여 처리.

-   `_would_cross`: BUY는 `best_ask is not None and taker.price >= best_ask`, SELL은
    `best_bid is not None and taker.price <= best_bid`. 참이면 `status = REJECTED`, `updated_orders == [taker]`,
    매칭 루프 진입 없음(책 무변경).
-   거짓이면 매칭 루프에 들어가지만 `_peek_best_maker`가 가격 한도에서 None을 돌려주므로 체결이 날 수 없다.
    그래서 GTC면 `book.add(taker)`로 OPEN rest, IOC면 CANCELED, FOK면 사전 합산 0으로 REJECTED.

원본 설계의 "STP 모드와의 상호작용" 절은 이 엔진에 해당 없음(STP 부재). 요지("POST_ONLY 체크가 매칭
전에 먼저 돌아 STP 분기는 도달하지 않는다")는 이 엔진에서도 순서상 같다.

거부 표현: `OrderReject("POST_ONLY_WOULD_TRADE")` 대신 `status == REJECTED`. FOK 거부와 status가 같으므로
테스트는 시나리오 자체로 원인을 구분한다.

---

## 2. 방어 케이스 (D*)

-   **D1 – BUY POST_ONLY, 매칭 가능한 ask 존재 → REJECTED, 책 무변경**
    -   `best_ask <= taker.price`. 체결 0, `book_state()` seq 포함 동일.
    -   경계: `taker.price == best_ask`(정확히 같은 가격)와 `taker.price > best_ask`(더 높은 가격) 둘 다 거부.
-   **D2 – SELL POST_ONLY, 매칭 가능한 bid 존재 → REJECTED, 책 무변경** — D1 대칭.
-   **D3 – 반대편이 비어 있으면 일반 GTC 삽입과 동일** — 체결 0, OPEN rest, best = taker.price.
-   **D4 – 반대편에 유동성이 있지만 매칭 불가면 일반 GTC 삽입과 동일** — 반대편 레벨 무변경.

---

## 3. 도메인 유효 pairwise 시나리오

차원: **Side** × **OppositeBookState** ∈ {EMPTY, NON_MATCHING_SINGLE_LEVEL, MATCHING_SINGLE_LEVEL}.

| Scenario | S | OB | 기대 |
| --- | --- | --- | --- |
| S1 | BUY | EMPTY | rest, best bid = 100 |
| S2 | SELL | EMPTY | rest, best ask = 100 |
| S3 | BUY | NON_MATCHING (ask 110) | rest, ask 무변경 |
| S4 | SELL | NON_MATCHING (bid 90) | rest, bid 무변경 |
| S5 | BUY | MATCHING (ask 100, taker 100 또는 101) | REJECTED, 책 무변경 |
| S6 | SELL | MATCHING (bid 100, taker 100 또는 99) | REJECTED, 책 무변경 |

추가:

-   **같은 side 기존 레벨에 합류** — bid 99와 ask 100이 있을 때 POST_ONLY BUY 99는 교차하지 않으므로
    99 레벨 FIFO 뒤에 rest한다. "교차 판정은 반대편 best에만 의존"함을 확인.
-   **POST_ONLY + IOC**: 빈 책 → CANCELED, rest 없음. 매칭 불가 레벨이 있어도 CANCELED, 책 무변경.
-   **POST_ONLY + FOK**: 빈 책 → REJECTED, 책 무변경.
