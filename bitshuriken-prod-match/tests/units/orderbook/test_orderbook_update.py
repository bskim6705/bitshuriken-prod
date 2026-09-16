"""OrderBook.partial_fill — 방어(잘못된 fill_qty) + S1~S4. 설계: test_orderbook_update.md"""

import pytest

from engine.order import OrderSide
from scenario_support import ask_prices, bid_prices, book_state, level_ids, level_qty, limit, n, new_book

BUY, SELL = OrderSide.BUY, OrderSide.SELL


@pytest.fixture
def book():
    return new_book()


def test_update_d1_d8_invalid_fill_qty_raises_and_leaves_state(book):
    order = limit(BUY, id="buy-1", p="100", q="10")
    book.add(order)
    before = book_state(book)

    with pytest.raises(ValueError):
        book.partial_fill(order, 0)
    with pytest.raises(ValueError):
        book.partial_fill(order, -1)
    with pytest.raises(ValueError):
        book.partial_fill(order, n("10"))  # == remaining: 완전 체결은 cancel() 경로
    with pytest.raises(ValueError):
        book.partial_fill(order, n("11"))

    assert order.executed_qty == 0
    assert book_state(book) == before


def test_update_s1_buy_partial_fill_single_level(book):
    order = limit(BUY, id="buy-1", p="100", q="10")
    book.add(order)
    book.drain_dirty_levels()

    assert book.partial_fill(order, n("3")) is order

    assert order.executed_qty == n("3")
    assert order.remaining_qty == n("7")
    assert level_ids(book, BUY, n("100")) == ["buy-1"]
    assert book.best_bid_price() == n("100")
    assert book.contains("buy-1")
    assert book.seq == 2
    assert book.drain_dirty_levels() == [(BUY, n("100"), n("7"))]


def test_update_s2_sell_partial_fill_single_level(book):
    order = limit(SELL, id="sell-1", p="100", q="10")
    book.add(order)
    book.drain_dirty_levels()

    assert book.partial_fill(order, n("4")) is order

    assert order.remaining_qty == n("6")
    assert level_ids(book, SELL, n("100")) == ["sell-1"]
    assert book.best_ask_price() == n("100")
    assert book.drain_dirty_levels() == [(SELL, n("100"), n("6"))]


def test_update_s3_buy_partial_fill_does_not_touch_other_levels(book):
    best = limit(BUY, id="best-bid", p="105", q="10")
    lower = limit(BUY, id="lower-bid", p="100", q="5")
    book.add(best)
    book.add(lower)

    book.partial_fill(best, n("3"))

    assert best.remaining_qty == n("7")
    assert lower.remaining_qty == n("5")
    assert book.best_bid_price() == n("105")
    assert bid_prices(book) == [n("105"), n("100")]


def test_update_s3_sell_partial_fill_does_not_touch_other_levels(book):
    best = limit(SELL, id="best-ask", p="95", q="10")
    higher = limit(SELL, id="higher-ask", p="100", q="5")
    book.add(best)
    book.add(higher)

    book.partial_fill(best, n("3"))

    assert best.remaining_qty == n("7")
    assert higher.remaining_qty == n("5")
    assert book.best_ask_price() == n("95")
    assert ask_prices(book) == [n("95"), n("100")]


def test_update_s4_buy_partial_fill_one_of_many_keeps_fifo(book):
    o1 = limit(BUY, id="b1", p="100", q="10")
    o2 = limit(BUY, id="b2", p="100", q="8")
    o3 = limit(BUY, id="b3", p="100", q="6")
    for o in (o1, o2, o3):
        book.add(o)

    book.partial_fill(o2, n("5"))

    assert (o1.remaining_qty, o2.remaining_qty, o3.remaining_qty) == (n("10"), n("3"), n("6"))
    assert level_ids(book, BUY, n("100")) == ["b1", "b2", "b3"]
    assert level_qty(book, BUY, n("100")) == n("19")


def test_update_s4_sell_partial_fill_one_of_many_keeps_fifo(book):
    o1 = limit(SELL, id="s1", p="100", q="10")
    o2 = limit(SELL, id="s2", p="100", q="8")
    o3 = limit(SELL, id="s3", p="100", q="6")
    for o in (o1, o2, o3):
        book.add(o)

    book.partial_fill(o2, n("5"))

    assert (o1.remaining_qty, o2.remaining_qty, o3.remaining_qty) == (n("10"), n("3"), n("6"))
    assert level_ids(book, SELL, n("100")) == ["s1", "s2", "s3"]
    assert level_qty(book, SELL, n("100")) == n("19")
