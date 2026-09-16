"""LIMIT FOK, OB = EMPTY. 설계: test_ob_empty.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, TimeInForce
from scenario_support import book_state, limit, new_book

from .fok_support import assert_fok_rejected

BUY, SELL = OrderSide.BUY, OrderSide.SELL
FOK = TimeInForce.FOK


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_empty_fok_is_rejected(engine, book):
    before = book_state(book)
    taker = limit(BUY, id="fok-empty-buy", p="100", q="5", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert_fok_rejected(book, before, result, taker)
    assert book.best_bid_price() is None and book.best_ask_price() is None


def test_sell_empty_fok_is_rejected(engine, book):
    before = book_state(book)
    taker = limit(SELL, id="fok-empty-sell", p="100", q="5", tif=FOK)

    result = engine.submit_new_order(book, taker)

    assert_fok_rejected(book, before, result, taker)
    assert book.best_bid_price() is None and book.best_ask_price() is None
