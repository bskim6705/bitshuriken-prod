"""LIMIT FOK, OB = MATCHING_SINGLE_LEVEL_SINGLE_MAKER. 설계: test_ob_matching_single_level_single_maker.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus, TimeInForce
from scenario_support import book_state, limit, n, new_book, setup_asks, setup_bids, statuses, trade_tuples

from .fok_support import assert_fok_rejected

BUY, SELL = OrderSide.BUY, OrderSide.SELL
FOK = TimeInForce.FOK
PARTIAL, FILLED, OPEN = OrderStatus.PARTIAL, OrderStatus.FILLED, OrderStatus.OPEN


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_taker_smaller_single_sell_maker_full_fill_fok(engine, book):
    (maker,) = setup_asks(engine, book, [("100", "10", "ask-100")])
    taker = limit(BUY, id="fok-sm-buyer", p="100", q="4", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("fok-sm-buyer", "ask-100", n("100"), n("4"))]
    assert statuses(result) == {"ask-100": PARTIAL, "fok-sm-buyer": FILLED}
    assert maker.remaining_qty == n("6")
    assert book.best_ask_price() == n("100")


def test_sell_taker_smaller_single_buy_maker_full_fill_fok(engine, book):
    (maker,) = setup_bids(engine, book, [("100", "10", "bid-100")])
    taker = limit(SELL, id="fok-sm-seller", p="100", q="4", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("fok-sm-seller", "bid-100", n("100"), n("4"))]
    assert maker.remaining_qty == n("6") and taker.status == FILLED


def test_buy_taker_larger_single_sell_maker_fok_rejected(engine, book):
    (maker,) = setup_asks(engine, book, [("100", "3", "ask-100")])
    before = book_state(book)
    taker = limit(BUY, id="fok-lg-buyer", p="100", q="5", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert_fok_rejected(book, before, result, taker)
    assert maker.remaining_qty == n("3") and maker.status == OPEN  # maker 무접촉
    assert book.best_ask_price() == n("100") and book.best_bid_price() is None


def test_sell_taker_larger_single_buy_maker_fok_rejected(engine, book):
    (maker,) = setup_bids(engine, book, [("100", "3", "bid-100")])
    before = book_state(book)
    taker = limit(SELL, id="fok-lg-seller", p="100", q="5", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert_fok_rejected(book, before, result, taker)
    assert maker.remaining_qty == n("3")
    assert book.best_bid_price() == n("100") and book.best_ask_price() is None


def test_buy_exact_cross_single_sell_maker_full_fill_no_rest_fok(engine, book):
    (maker,) = setup_asks(engine, book, [("100", "5", "ask-100")])
    taker = limit(BUY, id="fok-eq-buyer", p="100", q="5", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("fok-eq-buyer", "ask-100", n("100"), n("5"))]
    assert maker.status == FILLED and taker.status == FILLED
    assert book.best_ask_price() is None and book.best_bid_price() is None


def test_sell_exact_cross_single_buy_maker_full_fill_no_rest_fok(engine, book):
    (maker,) = setup_bids(engine, book, [("100", "5", "bid-100")])
    taker = limit(SELL, id="fok-eq-seller", p="100", q="5", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("fok-eq-seller", "bid-100", n("100"), n("5"))]
    assert maker.status == FILLED and taker.status == FILLED
