# MatchEngine – LIMIT STANDARD IOC 테스트 설계 (overview)

`tests/scenarios/limit/standard/ioc/`가 표준 LIMIT IOC 주문을 `MatchEngine.submit_new_order`에
대해 어떻게 검증하는지 적는다.

-   `type = LIMIT`, `time_in_force = IOC` (`"I"`)

초점은 가격-시간 매칭의 정확성과, **잔여가 rest하지 않고 즉시 종결되는** IOC 의미론이다.

---

## 1. 범위와 전제

GTC overview §1과 같다. 추가로:

-   매칭엔진 수준 테스트가 단정하는 것: 어떤 체결이 나는가, taker가 **전량 체결**됐는가 아니면
    **부분 체결 후 종결**됐는가, best 가격 기대치.
-   STP 없음(ADR-007 §7).

---

## 2. IOC LIMIT 매칭 의미론 (이 엔진)

-   매칭 루프는 GTC와 **완전히 동일**하다 — 반대편 레벨을 가격-시간 순으로 걷고, 가격 한도에서 멈춘다.
-   루프 뒤 잔여 처리만 다르다:
    -   `remaining_qty == 0` → FILLED.
    -   `remaining_qty > 0` → **rest하지 않는다.** status는 체결이 있었으면 **PARTIAL**(`"P"`),
        없었으면 **CANCELED**(`"C"`). 어느 쪽이든 `book.remember_terminated(taker.id)`로 종결 id에 기억된다.
-   원본은 잔여를 `SystemCancel(order_id, "IOC_LEFTOVER")`라는 별도 메시지로 알렸다. 이 엔진은
    **별도 취소 메시지가 없다** — OU의 최종 status가 곧 통지이고, "P가 종결인가"는 BE가 타입/TIF로
    판정해 EXPIRED로 기록한다(ADR-026). 그래서 테스트는 `cancels` 대신 다음 세 가지를 단정한다:
    1.  `taker.status in {PARTIAL, CANCELED}` (체결 유무에 따라 정확히 하나),
    2.  `not book.contains(taker.id)` (rest 없음),
    3.  `book.was_terminated(taker.id)` (종결 기억 — 중복 NO 방어).
-   매칭이 없는 경우(EMPTY / NON_MATCHING)에는 책이 **seq까지 포함해** 무변경이어야 한다(`book_state()`).

직관: IOC taker는 **매칭 중에는** GTC와 같지만, 남은 것은 즉시 사라진다.

---

## 3. pairwise 차원

GTC와 같은 분해(`S` × `OB` × `QRel`)에 IOC 기대치를 얹는다:

-   `OB = EMPTY` → 체결 0, CANCELED.
-   `OB = NON_MATCHING_SINGLE_LEVEL` → 체결 0, CANCELED, 반대편 무변경.
-   `MATCHING_*`:
    -   `QRel = smaller / equal` → FILLED, 잔여 없음.
    -   `QRel = larger` → 매칭 가능한 잔량을 전부 소비한 뒤 PARTIAL로 종결. rest 없음.

---

## 4. 시나리오 철학

파일 분할과 축 배분은 GTC와 동일(`test_ob_empty` … `test_ob_matching_multi_level`). 단일 레벨
파일이 매칭 조건 + 수량 축을, 다중 레벨 파일이 가격 축을 담당한다. IOC 고유 기대치:

-   전량 체결이면 GTC와 구분 불가(FILLED, rest 없음).
-   부분 체결이거나 매칭이 없으면 잔여는 **절대 책에 남지 않는다** — 특히 다중 레벨의 "스프레드 안 rest"
    케이스가 IOC에서는 "스프레드 안에 아무것도 없음"으로 바뀐다.

---

## 5. 범위 밖

POST_ONLY(+IOC 조합은 `post_only/`에서), GTC/FOK, MARKET, STP.
