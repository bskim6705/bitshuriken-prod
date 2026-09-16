"""무작위 주문 시퀀스 아래 오더북·매칭 불변식 — 시드 고정. 설계: test_book_invariants_random.md"""

import random
from collections import defaultdict

import pytest

from engine.matcher import MatchEngine
from engine.order import OrderSide, OrderStatus, OrderType, TimeInForce
from scenario_support import (
    QTY_STEP,
    SCALE,
    assert_index_consistent,
    assert_not_crossed,
    book_state,
    level_qty,
    make_order,
    new_book,
)

BUY, SELL = OrderSide.BUY, OrderSide.SELL

PRICES = [f"{p // 10}.{p % 10}" for p in range(950, 1051)]  # 95.0 … 105.0, tick 0.1
QTYS = ["0.001", "0.002", "0.005", "0.01", "0.05", "0.1", "0.25", "0.5", "1", "2"]
QUOTES = ["0.05", "5", "50", "100", "150.5"]
USERS = ["u1", "u2", "u3"]


def _pick_type(rng: random.Random) -> tuple[OrderType, TimeInForce]:
    r = rng.random()
    if r < 0.55:
        tif_r = rng.random()
        tif = TimeInForce.GTC if tif_r < 0.6 else TimeInForce.IOC if tif_r < 0.85 else TimeInForce.FOK
        return OrderType.LIMIT, tif
    if r < 0.80:
        return OrderType.MARKET, TimeInForce.IOC
    return OrderType.POST_ONLY, TimeInForce.GTC


@pytest.mark.parametrize("seed", [1, 7, 42, 2026, 31337])
def test_random_sequences_keep_invariants(seed):
    rng = random.Random(seed)
    engine = MatchEngine()
    book = new_book()

    orders = {}  # id -> Order
    rest_seq = {}  # id -> rest 순번 (FIFO 검증)
    rest_price = {}  # id -> rest 가격
    fills = defaultdict(int)  # id -> Σ 체결 qty
    quote = defaultdict(int)  # id -> Σ floor(qty × price)
    last_seq = 0
    counter = 0

    for _ in range(600):
        counter += 1
        book.drain_dirty_levels()

        if rng.random() < 0.3 and book._index:
            # ---- cancel: resting id(90%) 또는 unknown(10%) ----
            oid = rng.choice(list(book._index.keys())) if rng.random() < 0.9 else f"unknown-{counter}"
            seq_before = book.seq
            canceled = engine.submit_cancel_order(book, oid)
            if oid in orders and canceled is not None:
                assert canceled is orders[oid]
                assert canceled.status == OrderStatus.CANCELED
                assert not book.contains(oid) and book.was_terminated(oid)
                assert book.seq == seq_before + 1
                assert book.drain_dirty_levels() == [
                    (canceled.side, canceled.price, level_qty(book, canceled.side, canceled.price))
                ]
            else:
                assert canceled is None
                assert book.seq == seq_before
        else:
            # ---- new order ----
            otype, tif = _pick_type(rng)
            side = rng.choice((BUY, SELL))
            user = rng.choice(USERS)
            oid = f"o{counter}"
            if otype == OrderType.MARKET:
                if side == BUY and rng.random() < 0.4:
                    taker = make_order(side, id=oid, type=otype, tif=tif, oqq=rng.choice(QUOTES), user=user)
                else:
                    taker = make_order(side, id=oid, type=otype, tif=tif, oq=rng.choice(QTYS), user=user)
            else:
                taker = make_order(
                    side, id=oid, type=otype, tif=tif, p=rng.choice(PRICES), oq=rng.choice(QTYS), user=user
                )
            orders[oid] = taker
            before = book_state(book)

            result = engine.submit_new_order(book, taker)

            # 체결 검증 (이 제출 안의 trade 순서 = 가격-시간 우선)
            prev_price = None
            prev_rest = None
            for t in result.trades:
                maker = orders[t.maker_order_id]
                assert t.qty > 0 and t.qty % QTY_STEP == 0
                assert t.taker_order_id == taker.id and t.taker_side == taker.side
                assert maker.side != taker.side
                assert t.price == rest_price[maker.id] == maker.price
                if otype in (OrderType.LIMIT, OrderType.POST_ONLY):
                    assert (t.price <= taker.price) if side == BUY else (t.price >= taker.price)
                if prev_price is not None:
                    if side == BUY:
                        assert t.price >= prev_price
                    else:
                        assert t.price <= prev_price
                    if t.price == prev_price:
                        assert rest_seq[maker.id] > prev_rest  # 같은 가격은 먼저 rest한 maker 먼저
                prev_price, prev_rest = t.price, rest_seq[maker.id]
                fills[maker.id] += t.qty
                fills[taker.id] += t.qty
                q = t.qty * t.price // SCALE
                quote[maker.id] += q
                quote[taker.id] += q

            # 회계: 이 제출로 변한 모든 주문의 누적값이 체결 합과 일치
            for o in result.updated_orders:
                assert o.executed_qty == fills[o.id], o.id
                assert o.cumulative_quote_qty == quote[o.id], o.id
            assert result.updated_orders[-1] is taker  # taker는 항상 마지막에 통지

            # 종결/rest 규칙
            st = taker.status
            if st == OrderStatus.REJECTED:
                assert result.trades == [] and taker.executed_qty == 0
                assert book_state(book) == before
                assert not book.contains(taker.id)
            elif st in (OrderStatus.OPEN, OrderStatus.PARTIAL) and otype != OrderType.MARKET and tif == TimeInForce.GTC:
                assert book.contains(taker.id)
                assert taker.remaining_qty > 0
                rest_seq[taker.id] = counter
                rest_price[taker.id] = taker.price
            else:
                assert not book.contains(taker.id)
                assert st in (OrderStatus.FILLED, OrderStatus.PARTIAL, OrderStatus.CANCELED)
                assert book.was_terminated(taker.id)
                if st == OrderStatus.CANCELED:
                    assert result.trades == []
                if st == OrderStatus.PARTIAL:
                    assert result.trades and (otype == OrderType.MARKET or tif == TimeInForce.IOC)
            if otype == OrderType.POST_ONLY:
                assert result.trades == []
            if tif == TimeInForce.FOK:
                assert st in (OrderStatus.REJECTED, OrderStatus.FILLED)
                if st == OrderStatus.FILLED:
                    assert taker.remaining_qty == 0
            for o in result.updated_orders:
                if o.status == OrderStatus.FILLED:
                    assert not book.contains(o.id) and book.was_terminated(o.id)
                    if o.is_quote_driven:
                        assert o.remaining_quote_qty <= 0
                    else:
                        assert o.remaining_qty == 0

            if result.trades or book.contains(taker.id):
                assert book.seq > before[0]

            # dirty 레벨 보고값 = 실제 레벨 합산
            for lvl_side, price, qty in book.drain_dirty_levels():
                assert qty == level_qty(book, lvl_side, price)

        assert book.seq >= last_seq
        last_seq = book.seq
        assert_not_crossed(book)
        assert_index_consistent(book)

    # 전 구간 회계 대사: 모든 주문의 누적값이 자기 체결 합과 일치
    for oid, o in orders.items():
        assert o.executed_qty == fills[oid]
        assert o.cumulative_quote_qty == quote[oid]
    assert sum(fills.values()) % 2 == 0  # 체결 qty는 maker/taker 쌍으로 계상
