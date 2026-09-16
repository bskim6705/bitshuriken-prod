# OrderBook – 읽기 테스트 설계 (`best_*`, `get_*_levels`)

`tests/units/orderbook/test_orderbook_read.py`가 `OrderBook`의 읽기 전용 접근을 어떻게 검증하는지
적는다. 입력 방어는 create/update/delete 문서가 담당하고, 여기서는 도메인 유효 동작만 본다.

## 대상 함수

-   `best_bid_price() -> Optional[int]`
-   `best_ask_price() -> Optional[int]`
-   `get_bid_levels() -> Iterable[tuple[int, OrderedDict[str, Order]]]`
-   `get_ask_levels() -> Iterable[tuple[int, OrderedDict[str, Order]]]`

전부 인메모리 책에 대한 **read** 연산이다. 매칭 루프(`_peek_best_maker`)와 FOK 사전 합산
(`_has_full_liquidity`), 스냅샷 직렬화가 이 네 함수에 의존하므로 순서 보장이 곧 매칭 정확성이다.

## 목표

-   빈 책과 비어 있지 않은 책에서 best bid/ask가 정확히 보고된다.
-   레벨 순회 순서가 매칭 순서와 같다:
    -   bids: 높은 가격 → 낮은 가격 (SELL taker가 먹는 순서).
    -   asks: 낮은 가격 → 높은 가격 (BUY taker가 먹는 순서).

## 시나리오

-   **S1: 빈 책** — best 둘 다 `None`, 레벨 순회는 빈 시퀀스, `seq == 0`.
-   **S2: bids만, 여러 레벨** — 100/105/103 순으로 넣어도 순회는 `[105, 103, 100]`. best_bid = 105, best_ask = None.
-   **S3: asks만, 여러 레벨** — 100/95/98 순으로 넣어도 순회는 `[95, 98, 100]`. best_ask = 95, best_bid = None.
-   **S4: 양쪽** — bids 100/105, asks 110/108 → best_bid 105, best_ask 108, 순회 `[105, 100]` / `[108, 110]`.

삽입 순서와 무관하게 정렬이 유지되는지(`SortedDict`)가 S2/S3의 핵심이다.
