"""LIMIT GTC, OB = MATCHING_MULTI_LEVEL. 설계: test_ob_matching_multi_level.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus
from scenario_support import ask_prices, bid_prices, level_qty, limit, n, new_book, setup_asks, setup_bids, trade_tuples

BUY, SELL = OrderSide.BUY, OrderSide.SELL
PARTIAL, FILLED = OrderStatus.PARTIAL, OrderStatus.FILLED


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_smaller_total_depth_stops_mid_book_no_rest(engine, book):
    setup_asks(engine, book, [("95", "2", "ask-95"), ("100", "5", "ask-100"), ("110", "5", "ask-110")])
    book.drain_dirty_levels()
    taker = limit(BUY, id="ml-buy-smaller", p="110", q="4")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [
        ("ml-buy-smaller", "ask-95", n("95"), n("2")),
        ("ml-buy-smaller", "ask-100", n("100"), n("2")),
    ]
    assert taker.status == FILLED
    assert taker.cumulative_quote_qty == n("390")  # 2×95 + 2×100
    assert ask_prices(book) == [n("100"), n("110")]
    assert level_qty(book, SELL, n("100")) == n("3")
    assert book.best_bid_price() is None
    assert set(book.drain_dirty_levels()) == {(SELL, n("95"), 0), (SELL, n("100"), n("3"))}


def test_buy_larger_than_first_levels_stops_at_price_limit_rests_in_spread(engine, book):
    setup_asks(engine, book, [("95", "3", "ask-95"), ("100", "3", "ask-100"), ("110", "3", "ask-110")])
    taker = limit(BUY, id="ml-buy-inspread", p="105", q="10")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [
        ("ml-buy-inspread", "ask-95", n("95"), n("3")),
        ("ml-buy-inspread", "ask-100", n("100"), n("3")),
    ]
    assert taker.status == PARTIAL
    assert book.best_ask_price() == n("110")  # 가격 한도 밖 레벨은 무접촉
    assert book.best_bid_price() == n("105")  # 잔여 4가 스프레드 안 taker 가격에 rest
    assert taker.remaining_qty == n("4")
    assert level_qty(book, BUY, n("105")) == n("4")


def test_buy_larger_than_total_depth_walks_all_levels_rests_beyond_last(engine, book):
    setup_asks(engine, book, [("95", "3", "ask-95"), ("100", "3", "ask-100"), ("105", "3", "ask-105")])
    taker = limit(BUY, id="ml-buy-beyond", p="120", q="11")

    result = engine.submit_new_order(book, taker)

    assert [t[1] for t in trade_tuples(result)] == ["ask-95", "ask-100", "ask-105"]
    assert taker.status == PARTIAL
    assert book.best_ask_price() is None
    assert book.best_bid_price() == n("120")
    assert taker.remaining_qty == n("2")


def test_sell_smaller_total_depth_stops_mid_book_no_rest(engine, book):
    setup_bids(engine, book, [("110", "2", "bid-110"), ("105", "5", "bid-105"), ("95", "5", "bid-95")])
    taker = limit(SELL, id="ml-sell-smaller", p="95", q="4")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [
        ("ml-sell-smaller", "bid-110", n("110"), n("2")),
        ("ml-sell-smaller", "bid-105", n("105"), n("2")),
    ]
    assert taker.status == FILLED
    assert bid_prices(book) == [n("105"), n("95")]
    assert level_qty(book, BUY, n("105")) == n("3")
    assert book.best_ask_price() is None


def test_sell_larger_than_first_levels_stops_at_price_limit_rests_in_spread(engine, book):
    setup_bids(engine, book, [("110", "3", "bid-110"), ("105", "3", "bid-105"), ("95", "3", "bid-95")])
    taker = limit(SELL, id="ml-sell-inspread", p="100", q="10")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [
        ("ml-sell-inspread", "bid-110", n("110"), n("3")),
        ("ml-sell-inspread", "bid-105", n("105"), n("3")),
    ]
    assert taker.status == PARTIAL
    assert book.best_bid_price() == n("95")
    assert book.best_ask_price() == n("100")
    assert taker.remaining_qty == n("4")


def test_sell_larger_than_total_depth_walks_all_levels_rests_beyond_last(engine, book):
    setup_bids(engine, book, [("110", "3", "bid-110"), ("105", "3", "bid-105"), ("100", "3", "bid-100")])
    taker = limit(SELL, id="ml-sell-beyond", p="90", q="11")

    result = engine.submit_new_order(book, taker)

    assert [t[1] for t in trade_tuples(result)] == ["bid-110", "bid-105", "bid-100"]
    assert taker.status == PARTIAL
    assert book.best_bid_price() is None
    assert book.best_ask_price() == n("90")
    assert taker.remaining_qty == n("2")
