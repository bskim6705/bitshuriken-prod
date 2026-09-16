"""OrderBook 읽기 — best 가격과 레벨 순회 순서. 설계: test_orderbook_read.md"""

import pytest

from engine.order import OrderSide
from scenario_support import ask_prices, bid_prices, limit, n, new_book

BUY, SELL = OrderSide.BUY, OrderSide.SELL


@pytest.fixture
def book():
    return new_book()


def test_read_s1_empty_book(book):
    assert book.best_bid_price() is None
    assert book.best_ask_price() is None
    assert bid_prices(book) == []
    assert ask_prices(book) == []
    assert book.seq == 0


def test_read_s2_only_bids_yields_highest_first(book):
    book.add(limit(BUY, id="b1", p="100", q="1"))
    book.add(limit(BUY, id="b2", p="105", q="1"))
    book.add(limit(BUY, id="b3", p="103", q="1"))

    assert book.best_bid_price() == n("105")
    assert book.best_ask_price() is None
    assert bid_prices(book) == [n("105"), n("103"), n("100")]


def test_read_s3_only_asks_yields_lowest_first(book):
    book.add(limit(SELL, id="a1", p="100", q="1"))
    book.add(limit(SELL, id="a2", p="95", q="1"))
    book.add(limit(SELL, id="a3", p="98", q="1"))

    assert book.best_ask_price() == n("95")
    assert book.best_bid_price() is None
    assert ask_prices(book) == [n("95"), n("98"), n("100")]


def test_read_s4_both_sides(book):
    book.add(limit(BUY, id="b1", p="100", q="1"))
    book.add(limit(BUY, id="b2", p="105", q="1"))
    book.add(limit(SELL, id="a1", p="110", q="1"))
    book.add(limit(SELL, id="a2", p="108", q="1"))

    assert book.best_bid_price() == n("105")
    assert book.best_ask_price() == n("108")
    assert bid_prices(book) == [n("105"), n("100")]
    assert ask_prices(book) == [n("108"), n("110")]
