"""LIMIT GTC, OB = MATCHING_SINGLE_LEVEL_SINGLE_MAKER. 설계: test_ob_matching_single_level_single_maker.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus
from scenario_support import level_qty, limit, n, new_book, setup_asks, setup_bids, statuses, trade_tuples

BUY, SELL = OrderSide.BUY, OrderSide.SELL
PARTIAL, FILLED = OrderStatus.PARTIAL, OrderStatus.FILLED


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_taker_smaller_single_sell_maker_partial_fill_of_maker(engine, book):
    (maker,) = setup_asks(engine, book, [("100", "10", "ask-100")])
    taker = limit(BUY, id="sm-buyer", p="100", q="4")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("sm-buyer", "ask-100", n("100"), n("4"))]
    assert statuses(result) == {"ask-100": PARTIAL, "sm-buyer": FILLED}
    assert [o.id for o in result.updated_orders] == ["ask-100", "sm-buyer"]  # maker 먼저, taker 마지막
    assert maker.remaining_qty == n("6")
    assert book.best_ask_price() == n("100")
    assert book.best_bid_price() is None
    assert not book.contains("sm-buyer")
    assert taker.cumulative_quote_qty == n("400")


def test_sell_taker_smaller_single_buy_maker_partial_fill_of_maker(engine, book):
    (maker,) = setup_bids(engine, book, [("100", "10", "bid-100")])
    taker = limit(SELL, id="sm-seller", p="100", q="4")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("sm-seller", "bid-100", n("100"), n("4"))]
    assert statuses(result) == {"bid-100": PARTIAL, "sm-seller": FILLED}
    assert maker.remaining_qty == n("6")
    assert book.best_bid_price() == n("100")
    assert book.best_ask_price() is None


def test_buy_taker_larger_single_sell_maker_rests_with_leftover(engine, book):
    (maker,) = setup_asks(engine, book, [("100", "3", "ask-100")])
    taker = limit(BUY, id="lg-buyer", p="100", q="5")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("lg-buyer", "ask-100", n("100"), n("3"))]
    assert statuses(result) == {"ask-100": FILLED, "lg-buyer": PARTIAL}
    assert book.best_ask_price() is None
    assert book.best_bid_price() == n("100")  # 잔여 2가 bid로 rest
    assert book.contains("lg-buyer")
    assert taker.remaining_qty == n("2")
    assert level_qty(book, BUY, n("100")) == n("2")


def test_sell_taker_larger_single_buy_maker_rests_with_leftover(engine, book):
    (maker,) = setup_bids(engine, book, [("100", "3", "bid-100")])
    taker = limit(SELL, id="lg-seller", p="100", q="5")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("lg-seller", "bid-100", n("100"), n("3"))]
    assert statuses(result) == {"bid-100": FILLED, "lg-seller": PARTIAL}
    assert book.best_bid_price() is None
    assert book.best_ask_price() == n("100")
    assert taker.remaining_qty == n("2")
    assert level_qty(book, SELL, n("100")) == n("2")


def test_buy_exact_cross_single_sell_maker_full_fill_no_rest(engine, book):
    (maker,) = setup_asks(engine, book, [("100", "5", "ask-100")])
    taker = limit(BUY, id="eq-buyer", p="100", q="5")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("eq-buyer", "ask-100", n("100"), n("5"))]
    assert maker.status == FILLED and taker.status == FILLED
    assert book.best_ask_price() is None and book.best_bid_price() is None
    assert book.was_terminated("ask-100") and book.was_terminated("eq-buyer")


def test_sell_exact_cross_single_buy_maker_full_fill_no_rest(engine, book):
    (maker,) = setup_bids(engine, book, [("100", "5", "bid-100")])
    taker = limit(SELL, id="eq-seller", p="100", q="5")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("eq-seller", "bid-100", n("100"), n("5"))]
    assert maker.status == FILLED and taker.status == FILLED
    assert book.best_ask_price() is None and book.best_bid_price() is None
