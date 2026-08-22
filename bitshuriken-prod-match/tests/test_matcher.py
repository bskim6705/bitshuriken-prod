"""MatchEngine 단위 테스트 — Kafka 없이 엔진 직접 호출.

엔진은 부분체결 MARKET/IOC 잔여를 버리고 최종 status P를 발행한다
(EXPIRED 매핑은 BE 책임).
"""

import itertools

import pytest

from engine.matcher import MatchEngine
from engine.order import Order, OrderSide, OrderStatus, OrderType, TimeInForce
from engine.orderbook import OrderBook

SCALE = 10**8
QTY_STEP = SCALE // 10**3  # qtyPrecision=3
PRICE_TICK = SCALE // 10**1  # pricePrecision=1

_ids = itertools.count(1)


def n(s: str) -> int:
    """'100.5' → int * 10^8. 부동소수점 미사용."""
    whole, _, frac = s.partition(".")
    return int(whole) * SCALE + int((frac + "00000000")[:8])


def make_order(
    side: OrderSide,
    *,
    type: OrderType = OrderType.LIMIT,
    tif: TimeInForce = TimeInForce.GTC,
    p: str = "0",
    oq: str = "0",
    oqq: str = "0",
    user: str = "u1",
) -> Order:
    return Order(
        id=f"o{next(_ids)}",
        user_id=user,
        symbol="BTCUSDT",
        type=type,
        side=side,
        time_in_force=tif,
        price=n(p),
        orig_qty=n(oq),
        orig_quote_qty=n(oqq),
    )


@pytest.fixture
def book() -> OrderBook:
    return OrderBook(symbol="BTCUSDT", partition=0, qty_step=QTY_STEP, price_tick=PRICE_TICK)


@pytest.fixture
def engine() -> MatchEngine:
    return MatchEngine()


def rest_limit(engine: MatchEngine, book: OrderBook, side: OrderSide, p: str, q: str) -> Order:
    """LIMIT GTC를 book에 거치(rest)시키고 반환."""
    order = make_order(side, p=p, oq=q, user="maker")
    engine.submit_new_order(book, order)
    assert order.status == OrderStatus.OPEN
    return order


# ---------- 멱등성 (중복 NEW 재드라이브) ----------


def test_duplicate_active_order_id_is_rejected(engine, book):
    """이미 active(resting)한 id로 온 NEW는 조용히 삼키지 않고 REJECTED로 통지한다.
    재매칭/중복 add는 여전히 없고 resting 주문·seq는 불변 — 삼킴 대신 발행만 추가.
    (Kafka는 매번 새 Order를 역직렬화하므로 resting과 다른 인스턴스가 같은 id로 온다.)"""
    maker = rest_limit(engine, book, OrderSide.SELL, "100", "5")
    # 매칭 가능한 반대편 BUY를 책에 거치(cross 아님: 99 < 100)
    rest_limit(engine, book, OrderSide.BUY, "99", "5")
    seq_before = book.seq

    dup = make_order(OrderSide.BUY, tif=TimeInForce.IOC, p="100", oq="1", user="taker")
    dup.id = maker.id  # 같은 id, 다른 주문 인스턴스

    result = engine.submit_new_order(book, dup)

    assert result.trades == []  # 재매칭 없음
    assert result.updated_orders == [dup]  # 삼키지 않고 통지
    assert dup.status == OrderStatus.REJECTED  # 중복 active id → REJECTED
    assert book.contains(maker.id)  # resting 주문 유지
    assert maker.status == OrderStatus.OPEN  # resting 주문 불변
    assert book.seq == seq_before  # 책 무변경(add/cancel/매칭 없음)


class TestBaseDrivenMarketBuy:
    def test_full_fill(self, engine, book):
        maker = rest_limit(engine, book, OrderSide.SELL, "100", "1")
        taker = make_order(OrderSide.BUY, type=OrderType.MARKET, tif=TimeInForce.IOC, oq="0.4")

        assert taker.is_quote_driven is False  # oqq=0 → base-driven
        result = engine.submit_new_order(book, taker)

        assert [(t.price, t.qty) for t in result.trades] == [(n("100"), n("0.4"))]
        assert taker.status == OrderStatus.FILLED
        assert taker.executed_qty == n("0.4")
        assert taker.cumulative_quote_qty == n("40")
        assert maker.status == OrderStatus.PARTIAL
        assert maker.remaining_qty == n("0.6")

    def test_sweeps_price_levels_in_order(self, engine, book):
        rest_limit(engine, book, OrderSide.SELL, "100", "0.2")
        rest_limit(engine, book, OrderSide.SELL, "100.5", "0.3")
        taker = make_order(OrderSide.BUY, type=OrderType.MARKET, tif=TimeInForce.IOC, oq="0.4")

        result = engine.submit_new_order(book, taker)

        assert [(t.price, t.qty) for t in result.trades] == [
            (n("100"), n("0.2")),
            (n("100.5"), n("0.2")),
        ]
        assert taker.status == OrderStatus.FILLED
        assert taker.cumulative_quote_qty == n("40.1")

    def test_partial_fill_terminates_without_resting(self, engine, book):
        rest_limit(engine, book, OrderSide.SELL, "100", "0.3")
        taker = make_order(OrderSide.BUY, type=OrderType.MARKET, tif=TimeInForce.IOC, oq="0.5")

        engine.submit_new_order(book, taker)

        assert taker.status == OrderStatus.PARTIAL
        assert taker.executed_qty == n("0.3")
        assert book.best_bid_price() is None  # 잔여는 book에 거치되지 않음
        assert book.best_ask_price() is None

    def test_no_liquidity_canceled(self, engine, book):
        buy = make_order(OrderSide.BUY, type=OrderType.MARKET, tif=TimeInForce.IOC, oq="0.5")
        sell = make_order(OrderSide.SELL, type=OrderType.MARKET, tif=TimeInForce.IOC, oq="0.5")

        result_buy = engine.submit_new_order(book, buy)
        result_sell = engine.submit_new_order(book, sell)

        assert result_buy.trades == [] and buy.status == OrderStatus.CANCELED
        assert result_sell.trades == [] and sell.status == OrderStatus.CANCELED


# ---------- quote-driven MARKET BUY 회귀 (spot 의미론 불변) ----------


class TestQuoteDrivenMarketBuyRegression:
    def test_is_quote_driven_only_when_quote_budget(self):
        quote = make_order(OrderSide.BUY, type=OrderType.MARKET, tif=TimeInForce.IOC, oqq="50")
        base = make_order(OrderSide.BUY, type=OrderType.MARKET, tif=TimeInForce.IOC, oq="0.5")
        sell = make_order(OrderSide.SELL, type=OrderType.MARKET, tif=TimeInForce.IOC, oq="0.5")
        limit = make_order(OrderSide.BUY, p="100", oq="0.5")

        assert quote.is_quote_driven is True
        assert base.is_quote_driven is False
        assert sell.is_quote_driven is False
        assert limit.is_quote_driven is False

    def test_full_quote_spend_filled(self, engine, book):
        rest_limit(engine, book, OrderSide.SELL, "100", "1")
        taker = make_order(OrderSide.BUY, type=OrderType.MARKET, tif=TimeInForce.IOC, oqq="50")

        result = engine.submit_new_order(book, taker)

        assert [(t.price, t.qty) for t in result.trades] == [(n("100"), n("0.5"))]
        assert taker.cumulative_quote_qty == n("50")
        assert taker.status == OrderStatus.FILLED  # quote 예산 전액 소진

    def test_step_floor_leaves_quote_dust(self, engine, book):
        rest_limit(engine, book, OrderSide.SELL, "100", "1")
        taker = make_order(OrderSide.BUY, type=OrderType.MARKET, tif=TimeInForce.IOC, oqq="50.05")

        result = engine.submit_new_order(book, taker)

        # 0.5005 → stepSize(0.001) floor → 0.5 체결, quote 0.05는 dust
        assert [(t.price, t.qty) for t in result.trades] == [(n("100"), n("0.5"))]
        assert taker.cumulative_quote_qty == n("50")
        assert taker.remaining_quote_qty == n("0.05")
        assert taker.status == OrderStatus.PARTIAL

    def test_quote_below_one_step_canceled(self, engine, book):
        rest_limit(engine, book, OrderSide.SELL, "100", "1")
        taker = make_order(OrderSide.BUY, type=OrderType.MARKET, tif=TimeInForce.IOC, oqq="0.05")

        result = engine.submit_new_order(book, taker)

        assert result.trades == []
        assert taker.status == OrderStatus.CANCELED


# ---------- IOC / FOK / POST_ONLY ----------


class TestTimeInForceAndPostOnly:
    def test_ioc_limit_partial_does_not_rest(self, engine, book):
        rest_limit(engine, book, OrderSide.SELL, "100", "0.3")
        taker = make_order(OrderSide.BUY, tif=TimeInForce.IOC, p="100", oq="0.5")

        engine.submit_new_order(book, taker)

        assert taker.status == OrderStatus.PARTIAL
        assert taker.executed_qty == n("0.3")
        assert book.best_bid_price() is None

    def test_ioc_limit_no_cross_canceled(self, engine, book):
        rest_limit(engine, book, OrderSide.SELL, "101", "0.3")
        taker = make_order(OrderSide.BUY, tif=TimeInForce.IOC, p="100", oq="0.5")

        result = engine.submit_new_order(book, taker)

        assert result.trades == []
        assert taker.status == OrderStatus.CANCELED

    def test_fok_insufficient_liquidity_rejected(self, engine, book):
        maker = rest_limit(engine, book, OrderSide.SELL, "100", "0.3")
        rest_limit(engine, book, OrderSide.SELL, "101", "0.3")  # 가격 한도 밖 — 미집계
        taker = make_order(OrderSide.BUY, tif=TimeInForce.FOK, p="100", oq="0.5")

        result = engine.submit_new_order(book, taker)

        assert result.trades == []
        assert taker.status == OrderStatus.REJECTED
        assert maker.remaining_qty == n("0.3")  # book 무변경

    def test_fok_sufficient_liquidity_fills_all(self, engine, book):
        rest_limit(engine, book, OrderSide.SELL, "100", "0.3")
        rest_limit(engine, book, OrderSide.SELL, "100.5", "0.3")
        taker = make_order(OrderSide.BUY, tif=TimeInForce.FOK, p="100.5", oq="0.5")

        result = engine.submit_new_order(book, taker)

        assert taker.status == OrderStatus.FILLED
        assert sum(t.qty for t in result.trades) == n("0.5")

    def test_post_only_crossing_rejected(self, engine, book):
        rest_limit(engine, book, OrderSide.SELL, "100", "0.3")
        taker = make_order(OrderSide.BUY, type=OrderType.POST_ONLY, p="100", oq="0.5")

        result = engine.submit_new_order(book, taker)

        assert result.trades == []
        assert taker.status == OrderStatus.REJECTED

    def test_post_only_non_crossing_rests_open(self, engine, book):
        rest_limit(engine, book, OrderSide.SELL, "100", "0.3")
        taker = make_order(OrderSide.BUY, type=OrderType.POST_ONLY, p="99.9", oq="0.5")

        engine.submit_new_order(book, taker)

        assert taker.status == OrderStatus.OPEN
        assert book.best_bid_price() == n("99.9")


# ---------- LIMIT 가격-시간 우선 / cancel ----------


class TestPriceTimePriorityAndCancel:
    def test_price_then_fifo_within_level(self, engine, book):
        first_at_level = rest_limit(engine, book, OrderSide.SELL, "100.5", "0.2")
        better_price = rest_limit(engine, book, OrderSide.SELL, "100", "0.2")
        second_at_level = rest_limit(engine, book, OrderSide.SELL, "100.5", "0.2")
        taker = make_order(OrderSide.BUY, p="100.5", oq="0.5")

        result = engine.submit_new_order(book, taker)

        # 가격 우선 → 같은 가격은 도착 순서(FIFO)
        assert [t.maker_order_id for t in result.trades] == [
            better_price.id,
            first_at_level.id,
            second_at_level.id,
        ]
        assert [t.qty for t in result.trades] == [n("0.2"), n("0.2"), n("0.1")]
        assert taker.status == OrderStatus.FILLED
        assert second_at_level.status == OrderStatus.PARTIAL
        assert second_at_level.remaining_qty == n("0.1")

    def test_cancel_resting_order(self, engine, book):
        maker = rest_limit(engine, book, OrderSide.SELL, "100", "0.5")

        canceled = engine.submit_cancel_order(book, maker.id)

        assert canceled is maker
        assert maker.status == OrderStatus.CANCELED
        assert book.best_ask_price() is None

    def test_cancel_unknown_id_returns_none(self, engine, book):
        assert engine.submit_cancel_order(book, "unknown") is None


# ---------- depth diff / seq ----------


class TestDepthDiffSeq:
    def test_dirty_levels_and_seq_monotonic(self, engine, book):
        assert book.seq == 0

        maker = rest_limit(engine, book, OrderSide.SELL, "100", "0.5")
        assert book.seq == 1
        assert book.drain_dirty_levels() == [(OrderSide.SELL, n("100"), n("0.5"))]
        assert book.drain_dirty_levels() == []  # drain 후 clear

        # 부분 체결 → level 잔여 qty
        taker1 = make_order(OrderSide.BUY, type=OrderType.MARKET, tif=TimeInForce.IOC, oq="0.2")
        engine.submit_new_order(book, taker1)
        assert book.seq == 2
        assert book.drain_dirty_levels() == [(OrderSide.SELL, n("100"), n("0.3"))]

        # 전량 체결 → level 제거(qty=0)
        taker2 = make_order(OrderSide.BUY, type=OrderType.MARKET, tif=TimeInForce.IOC, oq="0.3")
        engine.submit_new_order(book, taker2)
        assert book.seq == 3
        assert book.drain_dirty_levels() == [(OrderSide.SELL, n("100"), 0)]
        assert maker.status == OrderStatus.FILLED


# ---------- maker 체결 회계 (OU eq/cqq 직렬화 원천 — BE dust 환불이 의존) ----------


class TestMakerFillAccounting:
    def test_full_fill_one_shot(self, engine, book):
        maker = rest_limit(engine, book, OrderSide.SELL, "100", "0.4")
        taker = make_order(OrderSide.BUY, p="100", oq="0.4")

        engine.submit_new_order(book, taker)

        assert maker.status == OrderStatus.FILLED
        assert maker.executed_qty == n("0.4")
        assert maker.cumulative_quote_qty == n("40")

    def test_partial_then_full_accumulates(self, engine, book):
        maker = rest_limit(engine, book, OrderSide.SELL, "100", "0.5")

        engine.submit_new_order(book, make_order(OrderSide.BUY, p="100", oq="0.2"))
        assert maker.status == OrderStatus.PARTIAL
        assert maker.executed_qty == n("0.2")
        assert maker.cumulative_quote_qty == n("20")

        engine.submit_new_order(book, make_order(OrderSide.BUY, p="100", oq="0.3"))
        assert maker.status == OrderStatus.FILLED
        assert maker.executed_qty == n("0.5")
        assert maker.cumulative_quote_qty == n("50")

    def test_taker_and_maker_mirror_each_other(self, engine, book):
        maker = rest_limit(engine, book, OrderSide.SELL, "100", "0.4")
        taker = make_order(OrderSide.BUY, p="100", oq="0.4")

        engine.submit_new_order(book, taker)

        assert maker.executed_qty == taker.executed_qty
        assert maker.cumulative_quote_qty == taker.cumulative_quote_qty
