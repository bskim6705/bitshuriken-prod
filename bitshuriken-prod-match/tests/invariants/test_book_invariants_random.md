# 무작위 시퀀스 불변식 테스트 설계

`tests/invariants/test_book_invariants_random.py`. 시나리오 매트릭스가 "이 입력에 이 출력"을 고정한다면,
이 파일은 "어떤 입력 순서에서도 깨지면 안 되는 성질"을 고정한다. 원본 설계에는 없던 층이지만, 원본이
OrderBook 방어 코드(교차 삽입 `RuntimeError`, index↔레벨 손상 `RuntimeError`)로 지키려던 불변식을 이 엔진에서는
**결과 검사**로 옮긴 것이다 — 엔진에 방어 코드를 넣지 않고도 같은 성질을 보장한다.

## 왜 hypothesis가 아니라 시드 고정 `random`인가

-   의존성 추가 없이(requirements.txt 불변) 재현 가능해야 한다. 실패하면 시드 하나로 그대로 재현된다.
-   시드 5개 × 600 연산이면 타입·TIF·side·가격·수량·취소가 충분히 섞인다(약 1~2초).
-   생성 분포: LIMIT 55%(GTC 60 / IOC 25 / FOK 15), MARKET 25%(BUY의 40%는 quote-driven), POST_ONLY 20%.
    연산의 30%는 취소(resting id 90% / unknown 10%). 가격 95.0~105.0(tick 0.1), 수량은 step(0.001) 정렬.
-   quote-driven + FOK 조합은 생성하지 않는다 — `scenarios/market/`의 xfail 갭 때문.

## 매 연산 후 검사하는 불변식

책(자료구조):

1.  **교차 없음**: `best_bid < best_ask` (둘 다 있을 때). 원본의 crossed-book 방어에 대응.
2.  **index ↔ 레벨 양방향 일치**: `_index`의 모든 id가 자기 (side, price) 레벨에 존재하고, 레벨의 모든 주문이
    index에 같은 (side, price)로 존재한다. 원본의 D4/D5 손상 가드에 대응.
3.  **빈 레벨 없음**, resting 주문은 `remaining_qty > 0`이고 status가 OPEN/PARTIAL.
4.  `seq` 단조 증가. 체결이나 rest가 있었으면 반드시 증가, REJECTED면 불변.
5.  `drain_dirty_levels()`가 보고한 레벨 qty == 실제 레벨 합산(depth diff의 정확성).

체결:

6.  `qty > 0`, step 정렬, `taker_order_id == taker.id`, `taker_side == taker.side`, maker는 반대 side.
7.  체결가 == maker가 rest한 가격(가격은 maker가 정한다).
8.  LIMIT/POST_ONLY taker는 가격 한도 준수(BUY: `price <= taker.price`, SELL: `>=`).
9.  한 제출 안에서 **가격 우선**(BUY 비감소 / SELL 비증가), 같은 가격은 **FIFO**(먼저 rest한 maker의 rest 순번이 작다).

회계:

10. 이 제출로 변한 모든 주문의 `executed_qty` == 자기 체결 qty 합, `cumulative_quote_qty` == Σ `floor(qty × price / SCALE)`
    (엔진이 체결마다 floor하므로 합도 체결별 floor의 합). 시퀀스 종료 후 전 주문에 대해 재검사.
11. `updated_orders`의 마지막은 항상 taker.

종결 규칙:

12. REJECTED → 체결 0, `book_state` 무변경, 책에 없음.
13. GTC LIMIT/POST_ONLY가 OPEN/PARTIAL이면 책에 있고 잔량 > 0. 그 외(FILLED/PARTIAL 종결/CANCELED)는 책에 없고
    `was_terminated` 참. CANCELED면 체결 0. PARTIAL 종결은 MARKET 또는 IOC에서만.
14. FOK → REJECTED 또는 FILLED(잔여 0). POST_ONLY → 체결 0.
15. FILLED로 통지된 주문(maker 포함)은 책에 없고 종결 기억에 있으며 잔량 0(quote-driven은 잔여 quote ≤ 0).
16. 취소: resting id면 같은 인스턴스 반환·CANCELED·책에서 제거·`was_terminated`·seq +1·dirty에 해당 레벨 잔량;
    unknown이면 None·seq 불변.

## 실패했을 때

시드와 연산 번호로 재현한 뒤, 실패한 불변식을 시나리오 매트릭스의 고정 테스트로 승격한다(원본 사고 재현
테스트 `test_lane_stall_repro.py`·`test_terminated_dedup_repro.py`와 같은 방식).
