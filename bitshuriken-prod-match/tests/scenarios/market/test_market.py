"""MARKET — base/quote-driven 매트릭스, MARKET+FOK, Trade 필드, 자전거래. 설계: test_market.md"""

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus, OrderType, TimeInForce
from scenario_support import (
    book_state,
    level_ids,
    limit,
    make_order,
    market,
    n,
    new_book,
    setup_asks,
    setup_bids,
    statuses,
    trade_tuples,
)

BUY, SELL = OrderSide.BUY, OrderSide.SELL
PARTIAL, FILLED, CANCELED, REJECTED = (
    OrderStatus.PARTIAL,
    OrderStatus.FILLED,
    OrderStatus.CANCELED,
    OrderStatus.REJECTED,
)


@pytest.fixture
def engine():
    return MatchEngine()


@pytest.fixture
def book():
    return new_book()


def assert_terminated_without_rest(book, taker):
    assert not book.contains(taker.id)
    assert book.was_terminated(taker.id)


# ---------- base-driven 매트릭스 ----------


def test_buy_empty_is_canceled(engine, book):
    taker = market(BUY, id="mk-empty-buy", q="5")
    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == CANCELED
    assert_terminated_without_rest(book, taker)


def test_sell_empty_is_canceled(engine, book):
    taker = market(SELL, id="mk-empty-sell", q="5")
    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == CANCELED
    assert_terminated_without_rest(book, taker)


def test_buy_smaller_than_single_maker(engine, book):
    (maker,) = setup_asks(engine, book, [("100", "10", "ask-100")])
    taker = market(BUY, id="mk-sm-buy", q="4")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("mk-sm-buy", "ask-100", n("100"), n("4"))]
    assert statuses(result) == {"ask-100": PARTIAL, "mk-sm-buy": FILLED}
    assert maker.remaining_qty == n("6")


def test_buy_larger_than_single_maker_leftover_terminates(engine, book):
    (maker,) = setup_asks(engine, book, [("100", "3", "ask-100")])
    taker = market(BUY, id="mk-lg-buy", q="5")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [("mk-lg-buy", "ask-100", n("100"), n("3"))]
    assert maker.status == FILLED and taker.status == PARTIAL
    assert taker.remaining_qty == n("2")
    assert book.best_ask_price() is None and book.best_bid_price() is None
    assert_terminated_without_rest(book, taker)


def test_sell_multi_maker_fifo(engine, book):
    setup_bids(engine, book, [("100", "2", "m1"), ("100", "3", "m2"), ("100", "4", "m3")])
    taker = market(SELL, id="mk-multi-sell", q="5")

    result = engine.submit_new_order(book, taker)

    assert [(t[1], t[3]) for t in trade_tuples(result)] == [("m1", n("2")), ("m2", n("3"))]
    assert taker.status == FILLED
    assert level_ids(book, BUY, n("100")) == ["m3"]


def test_buy_walks_all_levels_ignoring_price(engine, book):
    setup_asks(engine, book, [("95", "3", "ask-95"), ("100", "3", "ask-100"), ("110", "3", "ask-110")])
    taker = market(BUY, id="mk-ml-buy", q="10")

    result = engine.submit_new_order(book, taker)

    assert trade_tuples(result) == [
        ("mk-ml-buy", "ask-95", n("95"), n("3")),
        ("mk-ml-buy", "ask-100", n("100"), n("3")),
        ("mk-ml-buy", "ask-110", n("110"), n("3")),
    ]
    assert taker.status == PARTIAL and taker.remaining_qty == n("1")
    assert taker.cumulative_quote_qty == n("915")  # 285 + 300 + 330
    assert book.best_ask_price() is None and book.best_bid_price() is None
    assert_terminated_without_rest(book, taker)


def test_sell_walks_all_levels_ignoring_price(engine, book):
    setup_bids(engine, book, [("110", "3", "bid-110"), ("105", "3", "bid-105"), ("95", "3", "bid-95")])
    taker = market(SELL, id="mk-ml-sell", q="10")

    result = engine.submit_new_order(book, taker)

    assert [t[1] for t in trade_tuples(result)] == ["bid-110", "bid-105", "bid-95"]
    assert taker.status == PARTIAL and taker.remaining_qty == n("1")
    assert taker.cumulative_quote_qty == n("930")  # 330 + 315 + 285
    assert book.best_bid_price() is None and book.best_ask_price() is None


# ---------- MARKET + FOK ----------


def test_base_fok_sufficient_depth_fills_all(engine, book):
    setup_asks(engine, book, [("95", "3", "ask-95"), ("100", "3", "ask-100")])
    taker = make_order(BUY, id="mk-fok-ok", type=OrderType.MARKET, tif=TimeInForce.FOK, oq="6")

    result = engine.submit_new_order(book, taker)

    assert [t[1] for t in trade_tuples(result)] == ["ask-95", "ask-100"]
    assert taker.status == FILLED and taker.executed_qty == n("6")
    assert book.best_ask_price() is None


def test_base_fok_insufficient_depth_rejected_book_unchanged(engine, book):
    setup_asks(engine, book, [("95", "3", "ask-95"), ("100", "3", "ask-100")])
    before = book_state(book)
    taker = make_order(BUY, id="mk-fok-no", type=OrderType.MARKET, tif=TimeInForce.FOK, oq="7")

    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == REJECTED
    assert book_state(book) == before


# ---------- quote-driven ----------


def test_quote_buy_walks_levels_and_spends_exact_budget(engine, book):
    setup_asks(engine, book, [("95", "1", "ask-95"), ("100", "1", "ask-100")])
    taker = market(BUY, id="mk-quote-ml", qq="150")

    result = engine.submit_new_order(book, taker)

    # 95에서 1개(95 소진) → 잔여 55로 100에서 0.55개 → 예산 정확히 소진
    assert trade_tuples(result) == [
        ("mk-quote-ml", "ask-95", n("95"), n("1")),
        ("mk-quote-ml", "ask-100", n("100"), n("0.55")),
    ]
    assert taker.status == FILLED
    assert taker.cumulative_quote_qty == n("150")
    assert taker.remaining_quote_qty == 0
    assert level_ids(book, SELL, n("100")) == ["ask-100"]  # 0.45 잔존


def test_quote_buy_empty_book_is_canceled(engine, book):
    taker = market(BUY, id="mk-quote-empty", qq="100")
    result = engine.submit_new_order(book, taker)

    assert result.trades == [] and taker.status == CANCELED
    assert_terminated_without_rest(book, taker)


@pytest.mark.xfail(
    strict=True,
    reason=(
        "알려진 갭: quote-driven FOK의 사전 유동성 검사는 stepSize floor를 고려하지 않아 "
        "'충분' 판정 후 dust만큼 못 채우고 PARTIAL로 끝난다. FOK는 FILLED 또는 REJECTED여야 한다. "
        "(test_market.md §4)"
    ),
)
def test_quote_fok_never_ends_partial(engine, book):
    setup_asks(engine, book, [("100", "1", "ask-100")])
    taker = make_order(BUY, id="mk-quote-fok", type=OrderType.MARKET, tif=TimeInForce.FOK, oqq="50.05")

    engine.submit_new_order(book, taker)

    assert taker.status in (FILLED, REJECTED)


# ---------- Trade 필드 · 자전거래 ----------


def test_trade_id_is_maker_dash_taker_and_sides_recorded(engine, book):
    setup_asks(engine, book, [("100", "1", "ask-1")])
    taker = limit(BUY, id="taker-1", p="100", q="1", user="alice")

    result = engine.submit_new_order(book, taker)

    (trade,) = result.trades
    assert trade.id == "ask-1-taker-1"
    assert trade.maker_order_id == "ask-1" and trade.taker_order_id == "taker-1"
    assert trade.maker_user_id == "maker" and trade.taker_user_id == "alice"
    assert trade.taker_side == BUY
    assert trade.symbol == "BTCUSDT"
    assert trade.ts > 0


def test_self_trade_is_allowed_no_stp(engine, book):
    """ADR-007 §7: 엔진은 user_id를 매칭 판단에 쓰지 않는다 — 같은 유저의 양쪽 주문도 정상 체결."""
    maker = limit(SELL, id="self-maker", p="100", q="1", user="same")
    engine.submit_new_order(book, maker)
    taker = limit(BUY, id="self-taker", p="100", q="1", user="same")

    result = engine.submit_new_order(book, taker)

    (trade,) = result.trades
    assert trade.maker_user_id == trade.taker_user_id == "same"
    assert maker.status == FILLED and taker.status == FILLED
