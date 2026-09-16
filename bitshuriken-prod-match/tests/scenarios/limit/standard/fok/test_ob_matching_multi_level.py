"""LIMIT FOK, OB = MATCHING_MULTI_LEVEL. 설계: test_ob_matching_multi_level.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus, TimeInForce
from scenario_support import ask_prices, bid_prices, book_state, level_qty, limit, n, new_book, setup_asks, setup_bids, trade_tuples

from .fok_support import assert_fok_rejected

BUY, SELL = OrderSide.BUY, OrderSide.SELL
FOK = TimeInForce.FOK
FILLED = OrderStatus.FILLED


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_smaller_total_depth_stops_mid_book_no_rest_fok(engine, book):
    setup_asks(engine, book, [("95", "2", "ask-95"), ("100", "5", "ask-100"), ("110", "5", "ask-110")])
    taker = limit(BUY, id="fok-ml-buy-smaller", p="110", q="4", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [
        ("fok-ml-buy-smaller", "ask-95", n("95"), n("2")),
        ("fok-ml-buy-smaller", "ask-100", n("100"), n("2")),
    ]
    assert taker.status == FILLED
    assert ask_prices(book) == [n("100"), n("110")]
    assert level_qty(book, SELL, n("100")) == n("3")


def test_buy_exactly_matchable_depth_fills_all_fok(engine, book):
    setup_asks(engine, book, [("95", "3", "ask-95"), ("100", "3", "ask-100"), ("110", "3", "ask-110")])
    taker = limit(BUY, id="fok-ml-buy-exact", p="100", q="6", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert [t[1] for t in trade_tuples(result)] == ["ask-95", "ask-100"]
    assert taker.status == FILLED
    assert ask_prices(book) == [n("110")]


def test_buy_larger_than_first_levels_stops_at_price_limit_fok_rejected(engine, book):
    # 95+100 = 6 < 10, 110은 가격 한도 밖이라 합산에서 제외
    setup_asks(engine, book, [("95", "3", "ask-95"), ("100", "3", "ask-100"), ("110", "3", "ask-110")])
    before = book_state(book)
    taker = limit(BUY, id="fok-ml-buy-inspread", p="105", q="10", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert_fok_rejected(book, before, result, taker)
    assert ask_prices(book) == [n("95"), n("100"), n("110")]


def test_buy_larger_than_total_depth_fok_rejected(engine, book):
    setup_asks(engine, book, [("95", "3", "ask-95"), ("100", "3", "ask-100"), ("105", "3", "ask-105")])
    before = book_state(book)
    taker = limit(BUY, id="fok-ml-buy-beyond", p="120", q="11", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert_fok_rejected(book, before, result, taker)


def test_sell_smaller_total_depth_stops_mid_book_no_rest_fok(engine, book):
    setup_bids(engine, book, [("110", "2", "bid-110"), ("105", "5", "bid-105"), ("95", "5", "bid-95")])
    taker = limit(SELL, id="fok-ml-sell-smaller", p="95", q="4", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [
        ("fok-ml-sell-smaller", "bid-110", n("110"), n("2")),
        ("fok-ml-sell-smaller", "bid-105", n("105"), n("2")),
    ]
    assert taker.status == FILLED
    assert bid_prices(book) == [n("105"), n("95")]


def test_sell_larger_than_first_levels_stops_at_price_limit_fok_rejected(engine, book):
    setup_bids(engine, book, [("110", "3", "bid-110"), ("105", "3", "bid-105"), ("95", "3", "bid-95")])
    before = book_state(book)
    taker = limit(SELL, id="fok-ml-sell-inspread", p="100", q="10", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert_fok_rejected(book, before, result, taker)
    assert bid_prices(book) == [n("110"), n("105"), n("95")]


def test_sell_larger_than_total_depth_fok_rejected(engine, book):
    setup_bids(engine, book, [("110", "3", "bid-110"), ("105", "3", "bid-105"), ("100", "3", "bid-100")])
    before = book_state(book)
    taker = limit(SELL, id="fok-ml-sell-beyond", p="90", q="11", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert_fok_rejected(book, before, result, taker)
