# MatchEngine – LIMIT STANDARD FOK 테스트 설계 (overview)

`tests/scenarios/limit/standard/fok/`가 FOK(Fill-Or-Kill) 표준 LIMIT 주문을
`MatchEngine.submit_new_order`에 대해 어떻게 검증하는지 적는다.

-   `type = LIMIT`, `time_in_force = FOK` (`"F"`)

초점은 **all-or-none**이다 — taker가 즉시 **전량 체결**되거나, **거부(kill)**되어 책에 아무 흔적도
남기지 않거나 둘 중 하나여야 한다.

---

## 1. 범위와 전제

GTC overview §1과 같다. 추가로 매칭엔진 수준 테스트가 단정하는 것:

-   taker가 **전량 체결**됐는가 vs **거부**됐는가.
-   전량 체결이면 어떤 체결이 났는가.
-   거부면 체결 0건이고 책이 **seq까지 포함해** 무변경인가.

---

## 2. FOK LIMIT 매칭 의미론 (이 엔진) — 원본과 다른 점

원본 엔진은 GTC처럼 **일단 매칭한 뒤** 잔여가 있으면 결과를 버리고 `OrderReject("FOK_LEFTOVER")`를
돌려줬다(provisional trades + rollback). 이 엔진은 순서가 반대다:

1.  **매칭 전 사전 합산** `_has_full_liquidity(book, taker)`:
    -   반대편 레벨을 가격-시간 순으로 걷되 LIMIT은 가격 한도에서 `break`한다
        (BUY: `price > taker.price`, SELL: `price < taker.price`).
    -   maker 잔량을 누적해 `target_qty = taker.orig_qty`에 도달하면 즉시 `True`.
2.  부족하면 → `taker.status = REJECTED`, `updated_orders == [taker]`, 매칭 루프 **진입 안 함**.
    책은 손대지 않았으므로 `book_state()`(seq 포함)가 동일하다.
3.  충분하면 → 일반 매칭 루프. 사전 합산이 정확하므로 반드시 잔여 0으로 **FILLED**된다.
    이 엔진의 FOK에는 "부분 체결 후 종결(P)"이 **존재하지 않는다** — 그게 곧 이 파일들이 보호하는
    불변식이다.

주의(다른 파일에서 다룸): quote-driven MARKET BUY + FOK는 사전 합산이 stepSize floor를 고려하지 않아
이 불변식이 깨진다. `scenarios/market/`에 xfail 명세로 남겨두었다. LIMIT FOK는 base-driven이라 영향 없다.

거부의 표현: 원본의 `OrderReject(reason)` 대신 `status == REJECTED` 하나다. reason 문자열은 없다 —
OU `st="R"`이 통지의 전부이고, BE는 REJECTED를 받으면 잠금을 환불한다.

---

## 3. pairwise 차원

GTC/IOC와 같은 분해(`S` × `OB` × `QRel`)에 FOK 기대치를 얹는다:

-   `OB = EMPTY` → 채울 수 없음 → REJECTED, 책 무변경.
-   `OB = NON_MATCHING_SINGLE_LEVEL` → 가격 한도 안 잔량 0 → REJECTED, 반대편 무변경.
-   `MATCHING_*`:
    -   `QRel = smaller / equal` → 전량 체결 → FILLED, rest 없음, 거부 없음.
    -   `QRel = larger` → **거부**, 책 무변경. "부분 체결된 FOK"는 호출자 관점에서 존재하지 않는다.
-   `MATCHING_MULTI_LEVEL`의 핵심은 **가격 한도 안 레벨의 합**이 기준이라는 것 — 한도 밖 레벨은
    합산에서 제외되므로 "책 전체 잔량은 충분해도 한도 안은 부족" 케이스가 REJECTED다.

---

## 4. 시나리오 철학

파일 분할은 GTC/IOC와 같다. 단일 레벨 파일이 매칭 조건 + 수량 축(성공/실패)을, 다중 레벨 파일이
가격 축(한도 안 합산)을 담당한다. 모든 거부 케이스는 공통 헬퍼 `assert_fok_rejected`로
"체결 0 · `updated_orders == [taker]` · REJECTED · `executed_qty == 0` · `book_state` 동일 ·
`contains` 거짓"을 한 번에 단정한다.

---

## 5. 범위 밖

POST_ONLY(+FOK 조합은 `post_only/`에서), GTC/IOC, MARKET(+FOK는 `market/`에서), STP.
