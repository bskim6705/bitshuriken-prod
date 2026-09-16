"""LIMIT GTC, OB = EMPTY. 설계: test_ob_empty.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus
from scenario_support import level_ids, limit, n, new_book

BUY, SELL = OrderSide.BUY, OrderSide.SELL


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_empty_rests_as_best_bid(engine, book):
    taker = limit(BUY, id="ob-empty-buy", p="100", q="5")

    result = engine.submit_new_order(book, taker)

    assert result.trades == []
    assert result.updated_orders == [taker]
    assert taker.status == OrderStatus.OPEN
    assert book.contains("ob-empty-buy")
    assert book.best_bid_price() == n("100")
    assert book.best_ask_price() is None
    assert level_ids(book, BUY, n("100")) == ["ob-empty-buy"]


def test_sell_empty_rests_as_best_ask(engine, book):
    taker = limit(SELL, id="ob-empty-sell", p="100", q="5")

    result = engine.submit_new_order(book, taker)

    assert result.trades == []
    assert result.updated_orders == [taker]
    assert taker.status == OrderStatus.OPEN
    assert book.best_ask_price() == n("100")
    assert book.best_bid_price() is None
    assert level_ids(book, SELL, n("100")) == ["ob-empty-sell"]
