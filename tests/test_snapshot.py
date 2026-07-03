"""스냅샷 직렬화/복원/replay 결정성 — Kafka 없이 엔진 객체 직접 검증.

trade ts는 벽시계라 run 간 비교에서 제외. 결정성 대상은 tid/가격/수량/주문 상태/depth.
"""

import json

from engine.matcher import MatchEngine
from engine.order import Order, OrderSide, OrderStatus, OrderType, TimeInForce
from engine.orderbook import OrderBook
from schemas.order_codec import OrderCodec
from schemas.snapshot import SnapshotMsg

SCALE = 10**8
QTY_STEP = SCALE // 10**3  # qtyPrecision=3
PRICE_TICK = SCALE // 10**1  # pricePrecision=1


def n(s: str) -> int:
    """'100.5' → int * 10^8. 부동소수점 미사용."""
    whole, _, frac = s.partition(".")
    return int(whole) * SCALE + int((frac + "00000000")[:8])


def make_book() -> OrderBook:
    return OrderBook(symbol="BTCUSDT", partition=0, qty_step=QTY_STEP, price_tick=PRICE_TICK)


def make_order(
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
    """고정 id — replay마다 동일 내용의 새 객체를 만든다."""
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


def trade_view(t) -> tuple:
    """ts 제외 비교 키 — tid 포함."""
    return (
        t.id,
        t.symbol,
        t.maker_order_id,
        t.taker_order_id,
        t.maker_user_id,
        t.taker_user_id,
        t.taker_side,
        t.price,
        t.qty,
    )


def apply_msgs(engine: MatchEngine, book: OrderBook, specs: list) -> tuple[list, list]:
    """NO/CO spec 목록을 순서대로 처리하고 (trades, order updates)를 즉시 캡처."""
    trades: list = []
    updates: list = []
    for spec in specs:
        if spec[0] == "NO":
            result = engine.submit_new_order(book, make_order(**spec[1]))
            trades += [trade_view(t) for t in result.trades]
            updates += [
                (o.id, o.status, o.executed_qty, o.cumulative_quote_qty)
                for o in result.updated_orders
            ]
        else:  # CO
            order = engine.submit_cancel_order(book, spec[1])
            if order is not None:
                updates.append(
                    (order.id, order.status, order.executed_qty, order.cumulative_quote_qty)
                )
    return trades, updates


def roundtrip(snap: SnapshotMsg) -> SnapshotMsg:
    """JSON 직렬화 경유 — Kafka 메시지와 동일 경로."""
    return SnapshotMsg.from_dict(json.loads(json.dumps(snap.to_dict())))


def test_snapshot_roundtrip_same_subsequent_results():
    engine = MatchEngine()
    seed = [
        ("NO", dict(oid="b1", side=OrderSide.BUY, p="99", oq="0.5", user="A")),
        ("NO", dict(oid="b2", side=OrderSide.BUY, p="99", oq="0.3", user="B")),
        ("NO", dict(oid="a1", side=OrderSide.SELL, p="101", oq="0.4", user="C")),
        # a1 부분체결 (executed_qty > 0 상태로 book에 잔존)
        (
            "NO",
            dict(
                oid="t1",
                side=OrderSide.BUY,
                type=OrderType.MARKET,
                tif=TimeInForce.IOC,
                oq="0.1",
                user="D",
            ),
        ),
        ("NO", dict(oid="a2", side=OrderSide.SELL, p="100.5", oq="0.2", user="E")),
    ]
    src = make_book()
    apply_msgs(engine, src, seed)

    restored = make_book()
    roundtrip(SnapshotMsg.from_book(src, offset=4)).restore_into(restored)

    assert restored.seq == src.seq

    # 이후 동일 입력 → 동일 체결(tid 포함)/주문 업데이트/depth
    follow = [("NO", dict(oid="t2", side=OrderSide.BUY, p="101", oq="1", user="F"))]
    out_src = apply_msgs(engine, src, follow)
    out_restored = apply_msgs(engine, restored, follow)

    assert out_src == out_restored
    # t2 BUY가 best ask a2(100.5) 먼저 체결 → tid = makerOrderId-takerOrderId
    assert out_src[0][0][0] == "a2-t2"
    assert SnapshotMsg.from_book(src, 0).to_dict() == SnapshotMsg.from_book(restored, 0).to_dict()


def test_replay_matches_uninterrupted_run():
    engine = MatchEngine()
    msgs = [
        ("NO", dict(oid="m1", side=OrderSide.SELL, p="100", oq="0.3", user="A")),
        ("NO", dict(oid="m2", side=OrderSide.SELL, p="100", oq="0.3", user="B")),
        ("NO", dict(oid="m3", side=OrderSide.SELL, p="100.5", oq="0.4", user="C")),
        (
            "NO",
            dict(
                oid="t1",
                side=OrderSide.BUY,
                type=OrderType.MARKET,
                tif=TimeInForce.IOC,
                oq="0.4",
                user="D",
            ),
        ),
        ("NO", dict(oid="m4", side=OrderSide.BUY, p="99.5", oq="0.6", user="E")),
        # --- 스냅샷 지점 (1..5) ---
        ("CO", "m3"),
        ("NO", dict(oid="t2", side=OrderSide.SELL, p="99.5", oq="0.2", user="F")),
        ("NO", dict(oid="m5", side=OrderSide.BUY, p="99", oq="0.5", user="G")),
        (
            "NO",
            dict(
                oid="t3",
                side=OrderSide.SELL,
                type=OrderType.MARKET,
                tif=TimeInForce.IOC,
                oq="1",
                user="H",
            ),
        ),
        ("NO", dict(oid="m6", side=OrderSide.SELL, p="101", oq="0.1", user="I")),
    ]

    # 무중단 처리
    a = make_book()
    out_a = apply_msgs(engine, a, msgs)

    # 1..5 처리 → 스냅샷 → 복원 → 6..10 재처리
    b = make_book()
    out_head = apply_msgs(engine, b, msgs[:5])
    snap = roundtrip(SnapshotMsg.from_book(b, offset=4))
    c = make_book()
    snap.restore_into(c)
    out_tail = apply_msgs(engine, c, msgs[5:])

    assert out_a[0] == out_head[0] + out_tail[0]  # trades, tid 포함
    assert out_a[1] == out_head[1] + out_tail[1]  # order updates
    assert SnapshotMsg.from_book(a, 9).to_dict() == SnapshotMsg.from_book(c, 9).to_dict()


def test_order_codec_wire_format_golden():
    """직렬화 wire format 고정 — 키 이름/string 변환이 바뀌면 실패한다."""
    order = Order(
        id="o1",
        user_id="u1",
        symbol="BTCUSDT",
        type=OrderType.LIMIT,
        side=OrderSide.BUY,
        time_in_force=TimeInForce.GTC,
        price=9900000000,
        orig_qty=50000000,
        orig_quote_qty=0,
        executed_qty=10000000,
        cumulative_quote_qty=990000000,
        status=OrderStatus.PARTIAL,
        ts=1718000000123,
    )
    golden = {
        "id": "o1",
        "u": "u1",
        "s": "BTCUSDT",
        "t": "L",
        "sd": "B",
        "tif": "G",
        "p": "9900000000",
        "oq": "50000000",
        "oqq": "0",
        "eq": "10000000",
        "cqq": "990000000",
        "st": "P",
        "ts": 1718000000123,
    }
    encoded = OrderCodec.to_dict(order)
    assert encoded == golden
    assert list(encoded.keys()) == list(golden.keys())  # JSON 키 순서까지 동일
    assert OrderCodec.from_dict(json.loads(json.dumps(encoded))) == order


def test_tid_deterministic_across_fresh_boots():
    """같은 입력은 부팅이 달라도 같은 tid를 낸다 — 엔진 재처리 시 BE 이중 정산 방지의 핵심."""
    engine = MatchEngine()
    msgs = [
        ("NO", dict(oid="m1", side=OrderSide.SELL, p="100", oq="0.3", user="A")),
        ("NO", dict(oid="m2", side=OrderSide.SELL, p="100", oq="0.3", user="B")),
        ("NO", dict(oid="t1", side=OrderSide.BUY, p="100", oq="0.5", user="C")),
    ]
    out1 = apply_msgs(engine, make_book(), msgs)
    out2 = apply_msgs(engine, make_book(), msgs)

    assert out1[0] == out2[0]  # trades 동일 (tid 포함) — wall-clock과 무관
    assert [t[0] for t in out1[0]] == ["m1-t1", "m2-t1"]


def test_fifo_within_level_preserved_after_restore():
    engine = MatchEngine()
    src = make_book()
    apply_msgs(
        engine,
        src,
        [
            ("NO", dict(oid="s1", side=OrderSide.SELL, p="100", oq="0.2", user="A")),
            ("NO", dict(oid="s2", side=OrderSide.SELL, p="100", oq="0.2", user="B")),
            ("NO", dict(oid="s3", side=OrderSide.SELL, p="100", oq="0.2", user="C")),
        ],
    )
    restored = make_book()
    roundtrip(SnapshotMsg.from_book(src, offset=2)).restore_into(restored)

    # 스냅샷 배열 순서 자체가 도착 순서(FIFO)
    assert [o["id"] for o in SnapshotMsg.from_book(restored, 0).asks] == ["s1", "s2", "s3"]

    result = engine.submit_new_order(restored, make_order("t1", OrderSide.BUY, p="100", oq="0.5"))
    assert [t.maker_order_id for t in result.trades] == ["s1", "s2", "s3"]
    assert [t.qty for t in result.trades] == [n("0.2"), n("0.2"), n("0.1")]
