"""LIMIT GTC, OB = MATCHING_SINGLE_LEVEL_MULTI_MAKER. 설계: test_ob_matching_single_level_multi_maker.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus
from scenario_support import level_ids, level_qty, limit, n, new_book, setup_asks, setup_bids, statuses, trade_tuples

BUY, SELL = OrderSide.BUY, OrderSide.SELL
PARTIAL, FILLED = OrderStatus.PARTIAL, OrderStatus.FILLED

MULTI = [("100", "2", "m1"), ("100", "3", "m2"), ("100", "4", "m3")]


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_smaller_than_total_ask_depth_multi_maker_no_rest(engine, book):
    setup_asks(engine, book, MULTI)
    taker = limit(BUY, id="multi-buy-smaller", p="100", q="5")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [
        ("multi-buy-smaller", "m1", n("100"), n("2")),
        ("multi-buy-smaller", "m2", n("100"), n("3")),
    ]
    assert statuses(result) == {"m1": FILLED, "m2": FILLED, "multi-buy-smaller": FILLED}
    assert level_ids(book, SELL, n("100")) == ["m3"]  # m3 무접촉
    assert level_qty(book, SELL, n("100")) == n("4")
    assert book.best_bid_price() is None


def test_buy_equal_to_total_ask_depth_multi_maker_no_rest(engine, book):
    setup_asks(engine, book, MULTI)
    taker = limit(BUY, id="multi-buy-equal", p="100", q="9")

    result = engine.submit_new_order(book, taker)

    assert [t[1] for t in trade_tuples(result)] == ["m1", "m2", "m3"]
    assert [t[3] for t in trade_tuples(result)] == [n("2"), n("3"), n("4")]
    assert taker.status == FILLED
    assert book.best_ask_price() is None and book.best_bid_price() is None


def test_buy_larger_than_total_ask_depth_multi_maker_rests_as_bid(engine, book):
    setup_asks(engine, book, MULTI)
    taker = limit(BUY, id="multi-buy-larger", p="100", q="11")

    result = engine.submit_new_order(book, taker)

    assert sum(t[3] for t in trade_tuples(result)) == n("9")
    assert taker.status == PARTIAL
    assert book.best_ask_price() is None
    assert book.best_bid_price() == n("100")
    assert taker.remaining_qty == n("2")
    assert level_ids(book, BUY, n("100")) == ["multi-buy-larger"]


def test_sell_smaller_than_total_bid_depth_multi_maker_no_rest(engine, book):
    setup_bids(engine, book, MULTI)
    taker = limit(SELL, id="multi-sell-smaller", p="100", q="5")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [
        ("multi-sell-smaller", "m1", n("100"), n("2")),
        ("multi-sell-smaller", "m2", n("100"), n("3")),
    ]
    assert level_ids(book, BUY, n("100")) == ["m3"]
    assert book.best_ask_price() is None


def test_sell_equal_to_total_bid_depth_multi_maker_no_rest(engine, book):
    setup_bids(engine, book, MULTI)
    taker = limit(SELL, id="multi-sell-equal", p="100", q="9")

    result = engine.submit_new_order(book, taker)

    assert [t[1] for t in trade_tuples(result)] == ["m1", "m2", "m3"]
    assert taker.status == FILLED
    assert book.best_bid_price() is None and book.best_ask_price() is None


def test_sell_larger_than_total_bid_depth_multi_maker_rests_as_ask(engine, book):
    setup_bids(engine, book, MULTI)
    taker = limit(SELL, id="multi-sell-larger", p="100", q="11")

    result = engine.submit_new_order(book, taker)

    assert sum(t[3] for t in trade_tuples(result)) == n("9")
    assert taker.status == PARTIAL
    assert book.best_bid_price() is None
    assert book.best_ask_price() == n("100")
    assert taker.remaining_qty == n("2")
