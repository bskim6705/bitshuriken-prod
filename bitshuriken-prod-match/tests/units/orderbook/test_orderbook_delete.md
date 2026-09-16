# OrderBook – `cancel` 테스트 설계

`tests/units/orderbook/test_orderbook_delete.py`가 `OrderBook.cancel`(원본의 `delete_order`)을
어떻게 검증하는지 적는다.

## 대상 함수

-   `cancel(order_id: str) -> Optional[Order]`

side 저장소(`_bids`/`_asks`)와 `_index` 양쪽에서 주문을 제거하고, 있었으면 그 `Order` 인스턴스를,
없었으면 `None`을 돌려준다. 빈 레벨은 즉시 삭제한다. 이 엔진 고유로 `seq`를 1 증가시키고
`(side, price)`를 dirty로 기록해, 사라진 레벨이 depth diff에 `qty=0`으로 실리게 한다.

## 방어 테스트

-   **D3: 존재하지 않는 order_id** — `None` 반환, 책 무변경, `seq` 무변경, dirty 기록 없음.
    "취소할 게 없다"는 도메인 케이스이고 예외가 아니다 — 엔진은 unknown id의 CO를 조용히 무시한다.

원본의 D1/D2(비문자열·공백 id → 예외)와 D4/D5(index가 사라진 레벨/주문을 가리키는 내부 손상 →
`RuntimeError`)는 이식하지 않았다. id 형식은 메시지 계층이 보장하고, 내부 손상 가드는 이 엔진에
없다. 대신 `tests/invariants/`가 매 연산 후 `_index`와 레벨의 양방향 일치를 검사한다 — 손상이
생기면 거기서 잡힌다.

## 시나리오 테스트

### 목표

유효한 취소가 side 저장소·index·best 가격·seq·dirty를 모두 올바르게 갱신하는지.

### 케이스

-   **S1: 빈 책에서 unknown 취소** — `None`, best 둘 다 `None`, seq 0.
-   **S2: 유일한 bid 취소** — 같은 인스턴스 반환, bid 레벨 없음, `contains` 거짓, seq +1,
    dirty = `[(BUY, 100, 0)]` (레벨 소멸 신호).
-   **S3: 유일한 ask 취소** — S2 대칭.
-   **S4: 같은 bid 가격의 셋 중 가운데 취소** — 레벨은 `[b-1, b-3]` FIFO 유지, index엔 나머지 둘만, 잔량 합 2.
-   **S5: 같은 ask 가격의 셋 중 가운데 취소** — S4 대칭.
-   **S6: best bid 취소 → 다음 레벨 승격** — 105 취소 후 best 100, 100 취소 후 `None`, index 비움.
-   **S7: best ask 취소 → 다음 레벨 승격** — 95 취소 후 best 100, 이후 `None`.
