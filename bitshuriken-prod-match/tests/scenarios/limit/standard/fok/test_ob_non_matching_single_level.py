"""LIMIT FOK, OB = NON_MATCHING_SINGLE_LEVEL. 설계: test_ob_non_matching_single_level.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, TimeInForce
from scenario_support import book_state, limit, n, new_book, setup_asks, setup_bids

from .fok_support import assert_fok_rejected

BUY, SELL = OrderSide.BUY, OrderSide.SELL
FOK = TimeInForce.FOK


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_below_best_ask_no_match_fok_is_rejected(engine, book):
    setup_asks(engine, book, [("110", "3", "ask-110")])
    before = book_state(book)
    taker = limit(BUY, id="fok-nonmatch-buy", p="100", q="5", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert_fok_rejected(book, before, result, taker)
    assert book.best_ask_price() == n("110") and book.best_bid_price() is None


def test_sell_above_best_bid_no_match_fok_is_rejected(engine, book):
    setup_bids(engine, book, [("90", "3", "bid-90")])
    before = book_state(book)
    taker = limit(SELL, id="fok-nonmatch-sell", p="100", q="5", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert_fok_rejected(book, before, result, taker)
    assert book.best_bid_price() == n("90") and book.best_ask_price() is None
