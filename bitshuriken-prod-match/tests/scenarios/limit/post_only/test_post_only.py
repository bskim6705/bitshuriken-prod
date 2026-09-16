"""POST_ONLY — would-trade 거부 / rest / IOC·FOK 조합. 설계: test_post_only.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus, TimeInForce
from scenario_support import book_state, level_ids, limit, n, new_book, setup_asks, setup_bids

BUY, SELL = OrderSide.BUY, OrderSide.SELL
OPEN, CANCELED, REJECTED = OrderStatus.OPEN, OrderStatus.CANCELED, OrderStatus.REJECTED


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


# ---------- D1 / D2 (would trade → REJECTED, 책 무변경) ----------


def test_post_only_buy_rejected_when_best_ask_would_trade(engine, book):
    setup_asks(engine, book, [("100", "1", "ask-1")])
    before = book_state(book)
    taker = limit(BUY, id="taker-buy-po", p="100", q="2", post_only=True)

    result = engine.submit_new_order(book, taker)

    assert result.trades == []
    assert result.updated_orders == [taker]
    assert taker.status == REJECTED
    assert book_state(book) == before


def test_post_only_buy_above_best_ask_is_rejected(engine, book):
    setup_asks(engine, book, [("100", "1", "ask-1")])
    before = book_state(book)
    taker = limit(BUY, id="taker-buy-po-above", p="101", q="2", post_only=True)

    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == REJECTED
    assert book_state(book) == before


def test_post_only_sell_rejected_when_best_bid_would_trade(engine, book):
    setup_bids(engine, book, [("100", "1", "bid-1")])
    before = book_state(book)
    taker = limit(SELL, id="taker-sell-po", p="100", q="2", post_only=True)

    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == REJECTED
    assert book_state(book) == before


def test_post_only_sell_below_best_bid_is_rejected(engine, book):
    setup_bids(engine, book, [("100", "1", "bid-1")])
    before = book_state(book)
    taker = limit(SELL, id="taker-sell-po-below", p="99", q="2", post_only=True)

    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == REJECTED
    assert book_state(book) == before


# ---------- D3 / S1 / S2 (빈 반대편 → 일반 GTC 삽입과 동일) ----------


def test_post_only_buy_on_empty_asks_rests_on_bid_side(engine, book):
    taker = limit(BUY, id="taker-buy-empty", p="100", q="2", post_only=True)

    result = engine.submit_new_order(book, taker)

    assert result.trades == []
    assert taker.status == OPEN
    assert book.best_bid_price() == n("100") and book.best_ask_price() is None
    assert level_ids(book, BUY, n("100")) == ["taker-buy-empty"]


def test_post_only_sell_on_empty_bids_rests_on_ask_side(engine, book):
    taker = limit(SELL, id="taker-sell-empty", p="100", q="2", post_only=True)

    result = engine.submit_new_order(book, taker)

    assert result.trades == []
    assert taker.status == OPEN
    assert book.best_ask_price() == n("100") and book.best_bid_price() is None
    assert level_ids(book, SELL, n("100")) == ["taker-sell-empty"]


# ---------- D4 / S3 / S4 (매칭 불가 레벨 → rest, 반대편 무변경) ----------


def test_post_only_buy_with_non_matching_ask_rests_without_trades(engine, book):
    setup_asks(engine, book, [("110", "1", "ask-1")])
    taker = limit(BUY, id="taker-buy-below-best-ask", p="100", q="2", post_only=True)

    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == OPEN
    assert book.best_ask_price() == n("110")
    assert book.best_bid_price() == n("100")


def test_post_only_sell_with_non_matching_bid_rests_without_trades(engine, book):
    setup_bids(engine, book, [("90", "1", "bid-1")])
    taker = limit(SELL, id="taker-sell-above-best-bid", p="100", q="2", post_only=True)

    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == OPEN
    assert book.best_bid_price() == n("90")
    assert book.best_ask_price() == n("100")


def test_post_only_buy_joins_existing_bid_level_fifo(engine, book):
    setup_bids(engine, book, [("99", "1", "bid-first")])
    setup_asks(engine, book, [("100", "1", "ask-1")])
    taker = limit(BUY, id="po-buy-join", p="99", q="2", post_only=True)

    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == OPEN
    assert level_ids(book, BUY, n("99")) == ["bid-first", "po-buy-join"]


# ---------- POST_ONLY + IOC / FOK ----------


def test_post_only_buy_ioc_on_empty_asks_is_immediately_canceled(engine, book):
    taker = limit(BUY, id="taker-buy-ioc-po", p="100", q="2", post_only=True, tif=TimeInForce.IOC)

    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == CANCELED
    assert not book.contains(taker.id)
    assert book.best_bid_price() is None and book.best_ask_price() is None


def test_post_only_sell_ioc_on_empty_bids_is_immediately_canceled(engine, book):
    taker = limit(SELL, id="taker-sell-ioc-po", p="100", q="2", post_only=True, tif=TimeInForce.IOC)

    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == CANCELED
    assert not book.contains(taker.id)


def test_post_only_buy_ioc_with_non_matching_ask_is_canceled_not_rested(engine, book):
    setup_asks(engine, book, [("110", "1", "ask-1")])
    before = book_state(book)
    taker = limit(BUY, id="taker-buy-ioc-po-nm", p="100", q="2", post_only=True, tif=TimeInForce.IOC)

    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == CANCELED
    assert book_state(book) == before


def test_post_only_buy_fok_on_empty_asks_is_rejected(engine, book):
    before = book_state(book)
    taker = limit(BUY, id="taker-buy-fok-po", p="100", q="2", post_only=True, tif=TimeInForce.FOK)

    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == REJECTED
    assert book_state(book) == before


def test_post_only_sell_fok_on_empty_bids_is_rejected(engine, book):
    before = book_state(book)
    taker = limit(SELL, id="taker-sell-fok-po", p="100", q="2", post_only=True, tif=TimeInForce.FOK)

    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == REJECTED
    assert book_state(book) == before
