"""LIMIT IOC, OB = NON_MATCHING_SINGLE_LEVEL. 설계: test_ob_non_matching_single_level.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus, TimeInForce
from scenario_support import book_state, limit, n, new_book, setup_asks, setup_bids

BUY, SELL = OrderSide.BUY, OrderSide.SELL
IOC = TimeInForce.IOC


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_below_best_ask_no_match_ioc_is_canceled_book_unchanged(engine, book):
    setup_asks(engine, book, [("110", "3", "ask-110")])
    before = book_state(book)
    taker = limit(BUY, id="ioc-nonmatch-buy", p="100", q="5", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert result.trades == []
    assert taker.status == OrderStatus.CANCELED
    assert book_state(book) == before  # 책 무변경(seq 포함)
    assert not book.contains(taker.id) and book.was_terminated(taker.id)
    assert book.best_ask_price() == n("110") and book.best_bid_price() is None


def test_sell_above_best_bid_no_match_ioc_is_canceled_book_unchanged(engine, book):
    setup_bids(engine, book, [("90", "3", "bid-90")])
    before = book_state(book)
    taker = limit(SELL, id="ioc-nonmatch-sell", p="100", q="5", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert result.trades == []
    assert taker.status == OrderStatus.CANCELED
    assert book_state(book) == before
    assert book.best_bid_price() == n("90") and book.best_ask_price() is None
