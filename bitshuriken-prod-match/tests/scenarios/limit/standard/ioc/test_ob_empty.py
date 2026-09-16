"""LIMIT IOC, OB = EMPTY. 설계: test_ob_empty.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus, TimeInForce
from scenario_support import limit, new_book

BUY, SELL = OrderSide.BUY, OrderSide.SELL
IOC = TimeInForce.IOC


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_empty_ioc_is_canceled_without_rest(engine, book):
    taker = limit(BUY, id="ioc-empty-buy", p="100", q="5", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert result.trades == []
    assert result.updated_orders == [taker]
    assert taker.status == OrderStatus.CANCELED
    assert not book.contains(taker.id) and book.was_terminated(taker.id)
    assert book.best_bid_price() is None and book.best_ask_price() is None


def test_sell_empty_ioc_is_canceled_without_rest(engine, book):
    taker = limit(SELL, id="ioc-empty-sell", p="100", q="5", tif=IOC)

    result = engine.submit_new_order(book, taker)

    assert result.trades == []
    assert taker.status == OrderStatus.CANCELED
    assert not book.contains(taker.id) and book.was_terminated(taker.id)
    assert book.best_bid_price() is None and book.best_ask_price() is None
