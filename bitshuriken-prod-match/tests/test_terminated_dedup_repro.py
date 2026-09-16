"""Repro: 종결(FILLED/CANCELED)된 order id로 온 중복 NO가 fresh taker로 재매칭됨.

Observation #24 (2026-07-15, AUDIT 포렌식 확정):
matcher.py의 중복 가드 `book.contains(taker.id)`는 **resting 중인 id만** 방어한다.
IOC/완전체결/취소로 북에서 사라진 id에 중복 NO가 도달하면(producer 재시도 / WAL replay
겹침 / BE 재드라이브) 엔진이 이를 fresh taker로 취급해 재매칭 → exec > orig(팬텀 체결).
실증: 949f76b6 (IOC, orig 0.06) 생성 1h45m 후 중복 NO로 exec 0.1191 발행, taker locked −77.81.

수정 후: 엔진이 종결 처리한 id를 lane별 bounded FIFO로 기억해, 중복 NO를 REJECTED로
반려한다(07-14 오전의 duplicate-active REJECTED 발신과 동일 경로). 재매칭 없음.

아래 (a)(b)(c)는 현재 코드에서 RED(재매칭 발생), fix 후 GREEN(REJECTED).
"""

import itertools

import pytest

from engine.matcher import MatchEngine
from engine.order import Order, OrderSide, OrderStatus, OrderType, TimeInForce
from engine.orderbook import OrderBook

SCALE = 10**8
QTY_STEP = SCALE // 10**3

_ids = itertools.count(1)


def n(s: str) -> int:
    whole, _, frac = s.partition(".")
    return int(whole) * SCALE + int((frac + "00000000")[:8])


def order(
    oid: str,
    side: OrderSide,
    *,
    type: OrderType = OrderType.LIMIT,
    tif: TimeInForce = TimeInForce.GTC,
    p: str = "0",
    oq: str = "0",
    oqq: str = "0",
    user: str = "u1",
) -> Order:
    """Kafka 역직렬화처럼 매번 새 Order 인스턴스. 같은 id로 재제출 가능."""
    return Order(
        id=oid,
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
    return OrderBook(symbol="BTCUSDT", qty_step=QTY_STEP)


@pytest.fixture
def engine() -> MatchEngine:
    return MatchEngine()


def rest_limit(engine, book, oid, side, p, q):
    o = order(oid, side, p=p, oq=q, user="maker")
    engine.submit_new_order(book, o)
    assert o.status == OrderStatus.OPEN
    return o


# ---------- (a) IOC 완전체결 후 중복 NO ----------

def test_duplicate_no_after_ioc_full_fill_is_rejected(engine, book):
    rest_limit(engine, book, "M", OrderSide.SELL, "100", "5")

    first = order("T1", OrderSide.BUY, tif=TimeInForce.IOC, p="100", oq="1", user="taker")
    r1 = engine.submit_new_order(book, first)
    assert first.status == OrderStatus.FILLED
    assert [(t.qty) for t in r1.trades] == [n("1")]
    assert not book.contains("T1")  # IOC 완전체결 → 북에 없음

    # 1h45m 후 같은 id의 중복 NO (다른 인스턴스). resting이 아니라 현재 가드를 우회.
    dup = order("T1", OrderSide.BUY, tif=TimeInForce.IOC, p="100", oq="1", user="taker")
    r2 = engine.submit_new_order(book, dup)

    assert r2.trades == []                        # 재매칭 없음 (RED: 현재는 체결 1건)
    assert dup.status == OrderStatus.REJECTED     # duplicate 종결 id 반려
    assert r2.updated_orders == [dup]
    # maker는 첫 체결분(1)만 소진돼야 함 — 팬텀 체결로 추가 소진 금지.
    assert book._index and book.best_ask_price() == n("100")


# ---------- (b) GTC resting → 완전체결 후 중복 NO ----------

def test_duplicate_no_after_gtc_maker_full_fill_is_rejected(engine, book):
    rest_limit(engine, book, "M1", OrderSide.SELL, "100", "1")  # GTC resting maker
    # taker가 M1을 완전 소진 → M1 FILLED, 북에서 제거.
    taker = order("BUY1", OrderSide.BUY, tif=TimeInForce.IOC, p="100", oq="1", user="taker")
    engine.submit_new_order(book, taker)
    assert not book.contains("M1")

    # 반대편 유동성(매칭 상대) 배치 후 M1 id로 중복 NO(SELL) 도착.
    rest_limit(engine, book, "BID", OrderSide.BUY, "100", "1")
    dup = order("M1", OrderSide.SELL, tif=TimeInForce.IOC, p="100", oq="1", user="maker")
    r = engine.submit_new_order(book, dup)

    assert r.trades == []                          # RED: 현재는 BID와 재매칭
    assert dup.status == OrderStatus.REJECTED
    assert book.contains("BID")                    # 반대편 유동성 무손상


# ---------- (c) 취소된 id 중복 NO ----------

def test_duplicate_no_after_cancel_is_rejected(engine, book):
    rest_limit(engine, book, "C1", OrderSide.SELL, "100", "1")
    canceled = engine.submit_cancel_order(book, "C1")
    assert canceled is not None and canceled.status == OrderStatus.CANCELED
    assert not book.contains("C1")

    rest_limit(engine, book, "BID", OrderSide.BUY, "100", "1")
    dup = order("C1", OrderSide.SELL, tif=TimeInForce.IOC, p="100", oq="1", user="maker")
    r = engine.submit_new_order(book, dup)

    assert r.trades == []                          # RED: 현재는 BID와 재매칭
    assert dup.status == OrderStatus.REJECTED
    assert book.contains("BID")


# ---------- 회귀: 종결 기억이 다른 id를 막지 않음 ----------

def test_distinct_fresh_id_still_matches_after_a_termination(engine, book):
    rest_limit(engine, book, "M", OrderSide.SELL, "100", "5")
    t1 = order("T1", OrderSide.BUY, tif=TimeInForce.IOC, p="100", oq="1", user="taker")
    engine.submit_new_order(book, t1)  # 종결 → 기억됨

    fresh = order("T2", OrderSide.BUY, tif=TimeInForce.IOC, p="100", oq="1", user="taker")
    r = engine.submit_new_order(book, fresh)
    assert fresh.status == OrderStatus.FILLED
    assert [t.qty for t in r.trades] == [n("1")]  # 다른 id는 정상 체결


# ---------- 메모리 바운드: 용량 초과 시 오래된 종결 id 축출 ----------

def test_terminated_memory_is_capacity_bounded(engine):
    from engine.orderbook import TERMINATED_MEMORY_CAPACITY, OrderBook

    b = OrderBook(symbol="X", qty_step=QTY_STEP)
    b.remember_terminated("oldest")
    for i in range(TERMINATED_MEMORY_CAPACITY):
        b.remember_terminated(f"id-{i}")

    # 용량 초과 → 가장 오래된 id 축출, 최근 것은 유지. 메모리 상한 준수.
    assert not b.was_terminated("oldest")
    assert b.was_terminated(f"id-{TERMINATED_MEMORY_CAPACITY - 1}")
    assert len(b._terminated) == TERMINATED_MEMORY_CAPACITY
