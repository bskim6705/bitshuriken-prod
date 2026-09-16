"""OrderBook.cancel — unknown id, 단일/다중 레벨 제거, best 승격, seq·dirty. 설계: test_orderbook_delete.md"""

import pytest

from engine.order import OrderSide
from scenario_support import ask_prices, bid_prices, level_ids, level_qty, limit, n, new_book

BUY, SELL = OrderSide.BUY, OrderSide.SELL


@pytest.fixture
def book():
    return new_book()


def test_delete_d3_unknown_id_on_empty_book_is_noop(book):
    assert book.cancel("unknown-id") is None
    assert book.seq == 0
    assert book.drain_dirty_levels() == []
    assert book._index == {}


def test_delete_s2_cancel_single_bid_removes_level_and_index(book):
    order = limit(BUY, id="bid-1", p="100", q="1")
    book.add(order)
    book.drain_dirty_levels()

    assert book.cancel("bid-1") is order
    assert book.best_bid_price() is None
    assert bid_prices(book) == []
    assert not book.contains("bid-1")
    assert book.seq == 2
    assert book.drain_dirty_levels() == [(BUY, n("100"), 0)]  # 사라진 레벨 = qty 0


def test_delete_s3_cancel_single_ask_removes_level_and_index(book):
    order = limit(SELL, id="ask-1", p="100", q="1")
    book.add(order)
    book.drain_dirty_levels()

    assert book.cancel("ask-1") is order
    assert book.best_ask_price() is None
    assert ask_prices(book) == []
    assert not book.contains("ask-1")
    assert book.drain_dirty_levels() == [(SELL, n("100"), 0)]


def test_delete_s4_cancel_one_of_many_at_same_bid_price_keeps_fifo(book):
    o1 = limit(BUY, id="b-1", p="100", q="1")
    o2 = limit(BUY, id="b-2", p="100", q="1")
    o3 = limit(BUY, id="b-3", p="100", q="1")
    for o in (o1, o2, o3):
        book.add(o)

    assert book.cancel("b-2") is o2

    assert level_ids(book, BUY, n("100")) == ["b-1", "b-3"]
    assert not book.contains("b-2")
    assert book.contains("b-1") and book.contains("b-3")
    assert level_qty(book, BUY, n("100")) == n("2")


def test_delete_s5_cancel_one_of_many_at_same_ask_price_keeps_fifo(book):
    o1 = limit(SELL, id="a-1", p="100", q="1")
    o2 = limit(SELL, id="a-2", p="100", q="1")
    o3 = limit(SELL, id="a-3", p="100", q="1")
    for o in (o1, o2, o3):
        book.add(o)

    assert book.cancel("a-2") is o2

    assert level_ids(book, SELL, n("100")) == ["a-1", "a-3"]
    assert not book.contains("a-2")


def test_delete_s6_cancel_best_bid_promotes_next_level(book):
    best = limit(BUY, id="bid-best", p="105", q="1")
    other = limit(BUY, id="bid-other", p="100", q="1")
    book.add(best)
    book.add(other)

    assert book.cancel("bid-best") is best
    assert book.best_bid_price() == n("100")

    assert book.cancel("bid-other") is other
    assert book.best_bid_price() is None
    assert bid_prices(book) == []
    assert book._index == {}


def test_delete_s7_cancel_best_ask_promotes_next_level(book):
    best = limit(SELL, id="ask-best", p="95", q="1")
    other = limit(SELL, id="ask-other", p="100", q="1")
    book.add(best)
    book.add(other)

    assert book.cancel("ask-best") is best
    assert book.best_ask_price() == n("100")

    assert book.cancel("ask-other") is other
    assert book.best_ask_price() is None
    assert book._index == {}
