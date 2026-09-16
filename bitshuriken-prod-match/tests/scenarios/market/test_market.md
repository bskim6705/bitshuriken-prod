# MatchEngine – MARKET 테스트 설계

원본 설계는 `tests/scenarios/market/…`를 "범위 밖, 별도 파일"로 예약만 해두었다. 이 엔진은 MARKET이
spot 미러링의 체결 리플레이 경로(taker bot)와 청산 IOC 주문의 경로라 반드시 덮어야 한다.

## 1. 의미론 (이 엔진)

-   `type = MARKET` (`"M"`), `price = 0`. TIF는 메시지상 IOC로 오지만 엔진은 **타입으로** 종결을 판정한다
    (`taker.type == MARKET or tif == IOC` → rest 없음).
-   `_peek_best_maker`가 MARKET에는 **가격 한도를 적용하지 않는다** — 반대편 전 레벨을 걷는다.
-   두 구동 방식:
    -   **base-driven** (`orig_qty > 0`): LIMIT과 같은 `min(maker.remaining, taker.remaining)`.
    -   **quote-driven** (`orig_quote_qty > 0`, spot MARKET BUY 전용): `max_base = remaining_quote × SCALE // price`
        → stepSize floor → `min(maker.remaining, max_base)`. 잔여 quote가 1 step도 못 사면 `fill_qty <= 0`으로 루프 종료.
        BE는 `origQuoteQty − cqq`를 dust로 환불한다.
-   잔여 처리: 전량 → FILLED, 체결 있음 → **PARTIAL**(BE가 EXPIRED로 매핑), 체결 없음 → **CANCELED**.
    원본은 유동성 부재를 `MARKET_NO_LIQUIDITY` 거부로 다뤘지만 이 엔진은 CANCELED다.
-   MARKET + FOK: 사전 합산(`_has_full_liquidity`)이 가격 한도 없이 전 레벨을 합산. 부족하면 REJECTED.

## 2. base-driven 매트릭스

| OB | 케이스 | 기대 |
| --- | --- | --- |
| EMPTY | BUY / SELL | 체결 0, CANCELED, rest 없음, `was_terminated` |
| SINGLE_MAKER | taker 작음 | maker PARTIAL, taker FILLED |
| SINGLE_MAKER | taker 큼 | maker FILLED, taker PARTIAL(잔여 2), 책 양쪽 비어 있음 |
| MULTI_MAKER | SELL 5 vs 2/3/4 | FIFO로 m1·m2 소진, m3 무접촉 |
| MULTI_LEVEL | BUY 10 vs 95:3/100:3/110:3 | **가격 무관하게** 세 레벨 전부 소진(9), PARTIAL 1, `cqq = 285+300+330 = 915` |
| MULTI_LEVEL | SELL 10 vs 110:3/105:3/95:3 | 대칭, `cqq = 330+315+285 = 930` |

LIMIT 다중 레벨 1.2("가격 한도에서 정지")에 대응하는 MARKET 케이스가 "전 레벨 관통"이라는 것이 대비의 핵심.

## 3. MARKET + FOK

-   asks `95:3, 100:3`, MARKET FOK BUY 6 → 합 6 ≥ 6 → FILLED 2건.
-   같은 책, MARKET FOK BUY 7 → 합 6 < 7 → REJECTED, 책 무변경.

## 4. quote-driven

-   asks `95:1, 100:1`, MARKET BUY `oqq = 150` → 95에서 1개(95 소진), 잔여 55로 100에서 0.55개 → 정확히 150 소진, FILLED.
    100 레벨에 0.45 잔존.
-   빈 책 → CANCELED.
-   **알려진 갭 (xfail, strict)**: `oqq = 50.05`, FOK, ask `100 / 1`. 사전 합산은 `1 × 100 = 100 ≥ 50.05`로 통과하지만
    매칭은 `0.5005 → step floor → 0.5`만 체결하고 잔여 0.05는 dust → status **PARTIAL**. FOK는 FILLED 또는 REJECTED여야
    하므로 `assert status in (FILLED, REJECTED)`를 strict xfail로 둔다 — 엔진이 고쳐지면 이 테스트가 통과로 바뀌고
    strict xfail이 실패해 마크를 지우라고 알려준다. 수정 방향: 사전 합산에서 quote → base 환산 시 step floor를 적용하거나,
    dust만 남은 경우를 FILLED로 판정.

## 5. Trade 필드 · 자전거래

-   `Trade.id == f"{maker.id}-{taker.id}"`(ADR-038, 재부팅/리플레이에도 동일), `taker_side`, maker/taker user id, symbol, ts.
-   **자전거래 허용**(ADR-007 §7): maker/taker `user_id`가 같아도 정상 체결. 봇=유저 환경에서 실제로 일어나며,
    STP 도입 시 이 테스트가 정책 변경을 잡아낸다.
