"""LIMIT GTC, OB = NON_MATCHING_SINGLE_LEVEL. 설계: test_ob_non_matching_single_level.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus
from scenario_support import level_qty, limit, n, new_book, setup_asks, setup_bids

BUY, SELL = OrderSide.BUY, OrderSide.SELL


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def test_buy_below_best_ask_no_match_rests_on_bid(engine, book):
    setup_asks(engine, book, [("110", "3", "ask-110")])
    taker = limit(BUY, id="nonmatch-buy", p="100", q="5")

    result = engine.submit_new_order(book, taker)

    assert result.trades == []
    assert taker.status == OrderStatus.OPEN
    assert book.best_ask_price() == n("110")  # 반대편 무변경
    assert level_qty(book, SELL, n("110")) == n("3")
    assert book.best_bid_price() == n("100")


def test_sell_above_best_bid_no_match_rests_on_ask(engine, book):
    setup_bids(engine, book, [("90", "3", "bid-90")])
    taker = limit(SELL, id="nonmatch-sell", p="100", q="5")

    result = engine.submit_new_order(book, taker)

    assert result.trades == []
    assert taker.status == OrderStatus.OPEN
    assert book.best_bid_price() == n("90")
    assert level_qty(book, BUY, n("90")) == n("3")
    assert book.best_ask_price() == n("100")
