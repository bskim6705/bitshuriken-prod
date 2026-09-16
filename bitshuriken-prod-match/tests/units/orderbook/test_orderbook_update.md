# OrderBook – `partial_fill` 테스트 설계

`tests/units/orderbook/test_orderbook_update.py`가 `OrderBook.partial_fill`(원본의
`partially_fill_order`)을 어떻게 검증하는지 적는다.

## 대상 함수

-   `partial_fill(order: Order, fill_qty: int) -> Order`

**부분 체결 전용** 헬퍼다. resting 주문의 `executed_qty`를 제자리에서 증가시키고(원본은 `quantity`를
감소시켰다 — 이 엔진은 원 수량을 보존하고 누적 체결량을 따로 두어 OU 메시지의 `eq`를 그대로
직렬화한다), 같은 인스턴스를 돌려준다. 완전 체결은 `cancel()` 경로다 — 그래서
`fill_qty >= remaining_qty`는 계약 위반으로 거부한다.

## 방어 테스트

-   **D1: fill_qty가 0 이하** → `ValueError`, `executed_qty` 불변, 책(seq 포함) 불변.
-   **D8: fill_qty ≥ remaining_qty** → `ValueError`. 완전 체결을 이 경로로 처리하면 레벨에
    잔량 0 주문이 남아 depth와 FIFO를 오염시키므로 차단한다.

원본의 D2~D7(index 부재·side 손상·레벨 손상·인스턴스 불일치·비정수 수량)은 이식하지 않았다.
이 엔진의 `partial_fill`은 매칭 루프가 방금 `_peek_best_maker`로 꺼낸 **같은 인스턴스**에만
호출하므로 인스턴스 불일치가 구조적으로 불가능하고, 내부 손상 가드는 없다(`tests/invariants/`가
결과 층에서 검사).

## 시나리오 테스트

### 목표

유효한 부분 체결이 수량만 바꾸고 가격·side·index·레벨 소속·FIFO를 건드리지 않는지, 그리고
`seq`/dirty가 depth diff에 올바른 잔량을 싣는지.

### 케이스

-   **S1: 단일 레벨 BUY 부분 체결** — 10 중 3 체결 → `executed_qty 3`, `remaining_qty 7`, 레벨 id 그대로,
    best 그대로, `contains` 참, seq +1, dirty = `[(BUY, 100, 7)]`.
-   **S2: 단일 레벨 SELL 부분 체결** — 10 중 4 → 잔량 6, dirty = `[(SELL, 100, 6)]`.
-   **S3: 다중 레벨** — best(105/95)를 부분 체결해도 다른 레벨(100)의 수량·best·정렬 불변. BUY/SELL 각각.
-   **S4: 같은 가격의 다중 주문** — 가운데(b2/s2)만 5 체결 → 그 주문만 변하고 FIFO `[b1, b2, b3]` 유지,
    레벨 합 19.
