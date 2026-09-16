"""LIMIT IOC, OB = MATCHING_SINGLE_LEVEL_SINGLE_MAKER. 설계: test_ob_matching_single_level_single_maker.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus, TimeInForce
from scenario_support import limit, n, new_book, setup_asks, setup_bids, statuses, trade_tuples

BUY, SELL = OrderSide.BUY, OrderSide.SELL
IOC = TimeInForce.IOC
PARTIAL, FILLED = OrderStatus.PARTIAL, OrderStatus.FILLED


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_taker_smaller_single_sell_maker_partial_fill_of_maker_ioc(engine, book):
    (maker,) = setup_asks(engine, book, [("100", "10", "ask-100")])
    taker = limit(BUY, id="ioc-sm-buyer", p="100", q="4", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("ioc-sm-buyer", "ask-100", n("100"), n("4"))]
    assert statuses(result) == {"ask-100": PARTIAL, "ioc-sm-buyer": FILLED}
    assert maker.remaining_qty == n("6")
    assert book.best_ask_price() == n("100")
    assert not book.contains(taker.id)


def test_sell_taker_smaller_single_buy_maker_partial_fill_of_maker_ioc(engine, book):
    (maker,) = setup_bids(engine, book, [("100", "10", "bid-100")])
    taker = limit(SELL, id="ioc-sm-seller", p="100", q="4", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("ioc-sm-seller", "bid-100", n("100"), n("4"))]
    assert maker.remaining_qty == n("6")
    assert taker.status == FILLED


def test_buy_taker_larger_single_sell_maker_ioc_leftover_canceled(engine, book):
    (maker,) = setup_asks(engine, book, [("100", "3", "ask-100")])
    taker = limit(BUY, id="ioc-lg-buyer", p="100", q="5", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("ioc-lg-buyer", "ask-100", n("100"), n("3"))]
    assert statuses(result) == {"ask-100": FILLED, "ioc-lg-buyer": PARTIAL}
    assert taker.executed_qty == n("3") and taker.remaining_qty == n("2")
    assert book.best_ask_price() is None
    assert book.best_bid_price() is None  # GTC와 달리 잔여가 rest하지 않음
    assert not book.contains(taker.id) and book.was_terminated(taker.id)


def test_sell_taker_larger_single_buy_maker_ioc_leftover_canceled(engine, book):
    (maker,) = setup_bids(engine, book, [("100", "3", "bid-100")])
    taker = limit(SELL, id="ioc-lg-seller", p="100", q="5", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("ioc-lg-seller", "bid-100", n("100"), n("3"))]
    assert taker.status == PARTIAL
    assert book.best_bid_price() is None and book.best_ask_price() is None
    assert not book.contains(taker.id) and book.was_terminated(taker.id)


def test_buy_exact_cross_single_sell_maker_full_fill_no_rest_ioc(engine, book):
    (maker,) = setup_asks(engine, book, [("100", "5", "ask-100")])
    taker = limit(BUY, id="ioc-eq-buyer", p="100", q="5", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("ioc-eq-buyer", "ask-100", n("100"), n("5"))]
    assert maker.status == FILLED and taker.status == FILLED
    assert book.best_ask_price() is None and book.best_bid_price() is None


def test_sell_exact_cross_single_buy_maker_full_fill_no_rest_ioc(engine, book):
    (maker,) = setup_bids(engine, book, [("100", "5", "bid-100")])
    taker = limit(SELL, id="ioc-eq-seller", p="100", q="5", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("ioc-eq-seller", "bid-100", n("100"), n("5"))]
    assert maker.status == FILLED and taker.status == FILLED
