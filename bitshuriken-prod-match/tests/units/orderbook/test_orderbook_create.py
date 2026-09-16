"""OrderBook.add — 방어(중복 id) + 도메인 유효 pairwise S1~S8. 설계: test_orderbook_create.md"""

import pytest

from engine.order import OrderSide
from scenario_support import ask_prices, bid_prices, book_state, level_ids, level_qty, limit, n, new_book

BUY, SELL = OrderSide.BUY, OrderSide.SELL


@pytest.fixture
def book():
    return new_book()


# ---------- 방어 ----------


def test_add_duplicate_id_raises_and_leaves_book_unchanged(book):
    first = limit(BUY, id="dup-1", p="100", q="1")
    book.add(first)
    before = book_state(book)

    with pytest.raises(ValueError, match="duplicate order id"):
        book.add(limit(BUY, id="dup-1", p="110", q="2"))

    assert book_state(book) == before  # seq 포함 무변경
    assert book.best_bid_price() == n("100")
    assert book.cancel("dup-1") is first  # 원본은 정상 취소 가능


# ---------- 도메인 유효 pairwise ----------


def test_add_s1_buy_into_empty_side_creates_best_level(book):
    order = limit(BUY, id="s1-buy-1", p="100", q="2")
    book.add(order)

    assert book.best_bid_price() == n("100")
    assert book.best_ask_price() is None
    assert bid_prices(book) == [n("100")]
    assert level_ids(book, BUY, n("100")) == ["s1-buy-1"]
    assert book.contains("s1-buy-1")
    assert book.seq == 1
    assert book.drain_dirty_levels() == [(BUY, n("100"), n("2"))]


def test_add_s2_sell_into_empty_side_creates_best_level(book):
    order = limit(SELL, id="s2-sell-1", p="100", q="3")
    book.add(order)

    assert book.best_ask_price() == n("100")
    assert book.best_bid_price() is None
    assert ask_prices(book) == [n("100")]
    assert level_ids(book, SELL, n("100")) == ["s2-sell-1"]
    assert book.seq == 1
    assert book.drain_dirty_levels() == [(SELL, n("100"), n("3"))]


def test_add_s3_buy_equal_to_best_appends_fifo(book):
    book.add(limit(BUY, id="s3-buy-1", p="100", q="1"))
    book.add(limit(BUY, id="s3-buy-2", p="100", q="2"))
    book.add(limit(BUY, id="s3-buy-3", p="100", q="3"))

    assert book.best_bid_price() == n("100")
    assert bid_prices(book) == [n("100")]
    assert level_ids(book, BUY, n("100")) == ["s3-buy-1", "s3-buy-2", "s3-buy-3"]
    assert level_qty(book, BUY, n("100")) == n("6")
    assert book.seq == 3


def test_add_s4_sell_equal_to_best_appends_fifo(book):
    book.add(limit(SELL, id="s4-sell-1", p="100", q="1"))
    book.add(limit(SELL, id="s4-sell-2", p="100", q="2"))
    book.add(limit(SELL, id="s4-sell-3", p="100", q="3"))

    assert book.best_ask_price() == n("100")
    assert ask_prices(book) == [n("100")]
    assert level_ids(book, SELL, n("100")) == ["s4-sell-1", "s4-sell-2", "s4-sell-3"]
    assert level_qty(book, SELL, n("100")) == n("6")


def test_add_s5_buy_better_price_becomes_new_best(book):
    book.add(limit(BUY, id="buy-existing", p="100", q="1"))
    book.add(limit(BUY, id="buy-new", p="110", q="2"))

    assert book.best_bid_price() == n("110")
    assert bid_prices(book) == [n("110"), n("100")]  # best 먼저(내림차순)
    assert level_ids(book, BUY, n("110")) == ["buy-new"]
    assert level_ids(book, BUY, n("100")) == ["buy-existing"]


def test_add_s6_sell_better_price_becomes_new_best(book):
    book.add(limit(SELL, id="sell-existing", p="100", q="1"))
    book.add(limit(SELL, id="sell-new", p="90", q="2"))

    assert book.best_ask_price() == n("90")
    assert ask_prices(book) == [n("90"), n("100")]  # best 먼저(오름차순)
    assert level_ids(book, SELL, n("90")) == ["sell-new"]
    assert level_ids(book, SELL, n("100")) == ["sell-existing"]


def test_add_s7_buy_worse_price_keeps_best_and_appends_fifo(book):
    book.add(limit(BUY, id="buy-best", p="110", q="1"))
    book.add(limit(BUY, id="buy-l1", p="100", q="2"))
    book.add(limit(BUY, id="buy-l2", p="100", q="3"))

    assert book.best_bid_price() == n("110")
    assert bid_prices(book) == [n("110"), n("100")]
    assert level_ids(book, BUY, n("100")) == ["buy-l1", "buy-l2"]


def test_add_s8_sell_worse_price_keeps_best_and_appends_fifo(book):
    book.add(limit(SELL, id="sell-best", p="90", q="1"))
    book.add(limit(SELL, id="sell-l1", p="100", q="2"))
    book.add(limit(SELL, id="sell-l2", p="100", q="3"))

    assert book.best_ask_price() == n("90")
    assert ask_prices(book) == [n("90"), n("100")]
    assert level_ids(book, SELL, n("100")) == ["sell-l1", "sell-l2"]
