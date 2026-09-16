"""LIMIT IOC, OB = MATCHING_SINGLE_LEVEL_MULTI_MAKER. 설계: test_ob_matching_single_level_multi_maker.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus, TimeInForce
from scenario_support import level_ids, limit, n, new_book, setup_asks, setup_bids, trade_tuples

BUY, SELL = OrderSide.BUY, OrderSide.SELL
IOC = TimeInForce.IOC
PARTIAL, FILLED = OrderStatus.PARTIAL, OrderStatus.FILLED

MULTI = [("100", "2", "m1"), ("100", "3", "m2"), ("100", "4", "m3")]


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_smaller_than_total_ask_depth_multi_maker_no_rest_ioc(engine, book):
    setup_asks(engine, book, MULTI)
    taker = limit(BUY, id="ioc-multi-buy-smaller", p="100", q="5", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert [(t[1], t[3]) for t in trade_tuples(result)] == [("m1", n("2")), ("m2", n("3"))]
    assert taker.status == FILLED
    assert level_ids(book, SELL, n("100")) == ["m3"]


def test_buy_equal_to_total_ask_depth_multi_maker_no_rest_ioc(engine, book):
    setup_asks(engine, book, MULTI)
    taker = limit(BUY, id="ioc-multi-buy-equal", p="100", q="9", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert [t[1] for t in trade_tuples(result)] == ["m1", "m2", "m3"]
    assert taker.status == FILLED
    assert book.best_ask_price() is None


def test_buy_larger_than_total_ask_depth_multi_maker_ioc_leftover_canceled(engine, book):
    setup_asks(engine, book, MULTI)
    taker = limit(BUY, id="ioc-multi-buy-larger", p="100", q="11", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert sum(t[3] for t in trade_tuples(result)) == n("9")
    assert taker.status == PARTIAL and taker.remaining_qty == n("2")
    assert book.best_ask_price() is None and book.best_bid_price() is None
    assert not book.contains(taker.id) and book.was_terminated(taker.id)


def test_sell_smaller_than_total_bid_depth_multi_maker_no_rest_ioc(engine, book):
    setup_bids(engine, book, MULTI)
    taker = limit(SELL, id="ioc-multi-sell-smaller", p="100", q="5", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert [(t[1], t[3]) for t in trade_tuples(result)] == [("m1", n("2")), ("m2", n("3"))]
    assert level_ids(book, BUY, n("100")) == ["m3"]


def test_sell_equal_to_total_bid_depth_multi_maker_no_rest_ioc(engine, book):
    setup_bids(engine, book, MULTI)
    taker = limit(SELL, id="ioc-multi-sell-equal", p="100", q="9", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert [t[1] for t in trade_tuples(result)] == ["m1", "m2", "m3"]
    assert taker.status == FILLED


def test_sell_larger_than_total_bid_depth_multi_maker_ioc_leftover_canceled(engine, book):
    setup_bids(engine, book, MULTI)
    taker = limit(SELL, id="ioc-multi-sell-larger", p="100", q="11", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert taker.status == PARTIAL
    assert book.best_bid_price() is None and book.best_ask_price() is None
    assert not book.contains(taker.id) and book.was_terminated(taker.id)
