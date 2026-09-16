"""LIMIT FOK, OB = MATCHING_SINGLE_LEVEL_MULTI_MAKER. 설계: test_ob_matching_single_level_multi_maker.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus, TimeInForce
from scenario_support import book_state, level_ids, limit, n, new_book, setup_asks, setup_bids, trade_tuples

from .fok_support import assert_fok_rejected

BUY, SELL = OrderSide.BUY, OrderSide.SELL
FOK = TimeInForce.FOK
FILLED = OrderStatus.FILLED

MULTI = [("100", "2", "m1"), ("100", "3", "m2"), ("100", "4", "m3")]


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_smaller_than_total_ask_depth_multi_maker_full_fill_fok(engine, book):
    setup_asks(engine, book, MULTI)
    taker = limit(BUY, id="fok-multi-buy-smaller", p="100", q="5", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert [(t[1], t[3]) for t in trade_tuples(result)] == [("m1", n("2")), ("m2", n("3"))]
    assert taker.status == FILLED
    assert level_ids(book, SELL, n("100")) == ["m3"]


def test_buy_equal_to_total_ask_depth_multi_maker_full_fill_fok(engine, book):
    setup_asks(engine, book, MULTI)
    taker = limit(BUY, id="fok-multi-buy-equal", p="100", q="9", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert [t[1] for t in trade_tuples(result)] == ["m1", "m2", "m3"]
    assert taker.status == FILLED and book.best_ask_price() is None


def test_buy_larger_than_total_ask_depth_multi_maker_fok_rejected(engine, book):
    setup_asks(engine, book, MULTI)
    before = book_state(book)
    taker = limit(BUY, id="fok-multi-buy-larger", p="100", q="11", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert_fok_rejected(book, before, result, taker)
    assert level_ids(book, SELL, n("100")) == ["m1", "m2", "m3"]


def test_sell_smaller_than_total_bid_depth_multi_maker_full_fill_fok(engine, book):
    setup_bids(engine, book, MULTI)
    taker = limit(SELL, id="fok-multi-sell-smaller", p="100", q="5", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert [(t[1], t[3]) for t in trade_tuples(result)] == [("m1", n("2")), ("m2", n("3"))]
    assert level_ids(book, BUY, n("100")) == ["m3"]


def test_sell_equal_to_total_bid_depth_multi_maker_full_fill_fok(engine, book):
    setup_bids(engine, book, MULTI)
    taker = limit(SELL, id="fok-multi-sell-equal", p="100", q="9", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert [t[1] for t in trade_tuples(result)] == ["m1", "m2", "m3"]
    assert taker.status == FILLED


def test_sell_larger_than_total_bid_depth_multi_maker_fok_rejected(engine, book):
    setup_bids(engine, book, MULTI)
    before = book_state(book)
    taker = limit(SELL, id="fok-multi-sell-larger", p="100", q="11", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert_fok_rejected(book, before, result, taker)
    assert level_ids(book, BUY, n("100")) == ["m1", "m2", "m3"]
