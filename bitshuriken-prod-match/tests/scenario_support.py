"""시나리오 테스트 공용 헬퍼 — 엔진 직접 호출(Kafka 불필요).

정밀도는 test_matcher.py와 동일: qtyPrecision=3, pricePrecision=1, 값은 int * 10^8.
"""

import itertools

from engine.matcher import MatchEngine, MatchResult
from engine.order import Order, OrderSide, OrderStatus, OrderType, TimeInForce
from engine.orderbook import OrderBook

SCALE = 10**8
QTY_STEP = SCALE // 10**3  # qtyPrecision=3

_ids = itertools.count(1)


def n(s: str) -> int:
    """'100.5' → int * 10^8. 부동소수점 미사용."""
    s = str(s)
    whole, _, frac = s.partition(".")
    return int(whole) * SCALE + int((frac + "00000000")[:8])


def new_book(symbol: str = "BTCUSDT") -> OrderBook:
    return OrderBook(symbol=symbol, qty_step=QTY_STEP)


def make_order(
    side: OrderSide,
    *,
    id: str | None = None,
    type: OrderType = OrderType.LIMIT,
    tif: TimeInForce = TimeInForce.GTC,
    p: str = "0",
    oq: str = "0",
    oqq: str = "0",
    user: str = "u1",
) -> Order:
    return Order(
        id=id or f"o{next(_ids)}",
        user_id=user,
        symbol="BTCUSDT",
        type=type,
        side=side,
        time_in_force=tif,
        price=n(p),
        orig_qty=n(oq),
        orig_quote_qty=n(oqq),
    )


def limit(
    side: OrderSide,
    *,
    id: str | None = None,
    p: str,
    q: str,
    tif: TimeInForce = TimeInForce.GTC,
    post_only: bool = False,
    user: str = "taker",
) -> Order:
    """LIMIT(또는 POST_ONLY) 주문 생성 — 시나리오 테이커/메이커 공용."""
    return make_order(
        side,
        id=id,
        type=OrderType.POST_ONLY if post_only else OrderType.LIMIT,
        tif=tif,
        p=p,
        oq=q,
        user=user,
    )


def market(side: OrderSide, *, id: str | None = None, q: str = "0", qq: str = "0", user: str = "taker") -> Order:
    """MARKET 주문. q=base-driven, qq=quote-driven(BUY만 의미)."""
    return make_order(side, id=id, type=OrderType.MARKET, tif=TimeInForce.IOC, oq=q, oqq=qq, user=user)


def setup_asks(engine: MatchEngine, book: OrderBook, levels: list[tuple[str, str, str]]) -> list[Order]:
    """(price, qty, id) 목록을 LIMIT GTC SELL 메이커로 거치(rest)시킨다."""
    makers = []
    for price, qty, oid in levels:
        maker = limit(OrderSide.SELL, id=oid, p=price, q=qty, user="maker")
        engine.submit_new_order(book, maker)
        assert maker.status == OrderStatus.OPEN, f"maker {oid} did not rest"
        makers.append(maker)
    return makers


def setup_bids(engine: MatchEngine, book: OrderBook, levels: list[tuple[str, str, str]]) -> list[Order]:
    """(price, qty, id) 목록을 LIMIT GTC BUY 메이커로 거치(rest)시킨다."""
    makers = []
    for price, qty, oid in levels:
        maker = limit(OrderSide.BUY, id=oid, p=price, q=qty, user="maker")
        engine.submit_new_order(book, maker)
        assert maker.status == OrderStatus.OPEN, f"maker {oid} did not rest"
        makers.append(maker)
    return makers


# ---------- 결과 관찰 ----------


def trade_tuples(result: MatchResult) -> list[tuple[str, str, int, int]]:
    """(taker_id, maker_id, price, qty) — 원 프로젝트 시나리오 표기와 동일."""
    return [(t.taker_order_id, t.maker_order_id, t.price, t.qty) for t in result.trades]


def statuses(result: MatchResult) -> dict[str, OrderStatus]:
    return {o.id: o.status for o in result.updated_orders}


def ask_prices(book: OrderBook) -> list[int]:
    return [p for p, _ in book.get_ask_levels()]


def bid_prices(book: OrderBook) -> list[int]:
    return [p for p, _ in book.get_bid_levels()]


def level_ids(book: OrderBook, side: OrderSide, price: int) -> list[str]:
    """해당 가격 레벨의 주문 id를 FIFO 순으로. 레벨이 없으면 []."""
    levels = book.get_bid_levels() if side == OrderSide.BUY else book.get_ask_levels()
    for p, level in levels:
        if p == price:
            return list(level.keys())
    return []


def level_qty(book: OrderBook, side: OrderSide, price: int) -> int:
    levels = book.get_bid_levels() if side == OrderSide.BUY else book.get_ask_levels()
    for p, level in levels:
        if p == price:
            return sum(o.remaining_qty for o in level.values())
    return 0


def book_state(book: OrderBook) -> tuple:
    """비교 가능한 책 스냅샷 — 거부 경로가 책을 건드리지 않았음을 seq까지 포함해 단정."""
    bids = tuple((p, tuple((o.id, o.remaining_qty) for o in lvl.values())) for p, lvl in book.get_bid_levels())
    asks = tuple((p, tuple((o.id, o.remaining_qty) for o in lvl.values())) for p, lvl in book.get_ask_levels())
    return (book.seq, bids, asks)


def assert_not_crossed(book: OrderBook) -> None:
    bb, ba = book.best_bid_price(), book.best_ask_price()
    if bb is not None and ba is not None:
        assert bb < ba, f"crossed book: best_bid={bb} best_ask={ba}"


def assert_index_consistent(book: OrderBook) -> None:
    """_index ↔ 레벨 양방향 일치, 빈 레벨 없음, resting 주문은 잔량>0 & OPEN/PARTIAL."""
    seen: set[str] = set()
    for side, levels in ((OrderSide.BUY, book.get_bid_levels()), (OrderSide.SELL, book.get_ask_levels())):
        for price, level in levels:
            assert len(level) > 0, f"empty level left behind: {side} {price}"
            for oid, order in level.items():
                assert order.side == side and order.price == price
                assert order.remaining_qty > 0, f"resting order {oid} has no remaining qty"
                assert order.status in (OrderStatus.OPEN, OrderStatus.PARTIAL), (oid, order.status)
                assert book._index.get(oid) == (side, price), f"index mismatch for {oid}"
                seen.add(oid)
    assert seen == set(book._index.keys()), "index has ids that are not in any level"
