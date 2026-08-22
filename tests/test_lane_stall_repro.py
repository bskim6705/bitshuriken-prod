"""Repro: 재시작 후 lane이 last_offset은 전진하는데 fresh NO를 삼켜 무발행/무체결.

Live incident (2026-07-14 10:20~10:45 KST, ZECUSDT p1 단독):
- state 스냅샷 offset(=lane.last_offset)은 전진 (2.84M→2.94M)
- book.seq는 사실상 정지 (+33/25min)
- match.spot.out p1에 ZEC OU/TR 0건 — dozens/min의 NO가 아무것도 발행 못 함

메커니즘: 이미 active(resting)한 id로 온 NEW를 submit_new_order가 빈 MatchResult로
삼킨다(matcher.py:37-38). 핫루프는 빈 결과라 아무것도 발행하지 않지만 last_offset은
전진(main.py:168)시키고 dirty로 마킹 → 밖에서 보면 lane은 살아있는데(오프셋·스냅샷 전진)
해당 주문엔 귀머거리. unknown-id CO 홍수는 별개의 no-op으로 오프셋만 밀어올린다.

이 테스트는 실제 MatchEngine + 실제 OutboundPublisher(record용 producer stub) +
main.py:144-171 가드/디스패치 사본으로 그 상황을 그대로 재생한다.
"""

import pytest

from engine.lane import Lane, build_lane
from engine.matcher import MatchEngine
from engine.order import Order, OrderSide, OrderStatus, OrderType, TimeInForce
from messaging.outbound import OutboundPublisher
from messaging.topics import OP_CANCEL_ORDER, OP_NEW_ORDER
from schemas.messages import CancelOrderMsg, NewOrderMsg, op_of

SCALE = 10**8


def n(s: str) -> int:
    whole, _, frac = s.partition(".")
    return int(whole) * SCALE + int((frac + "00000000")[:8])


class RecordingProducer:
    """OutboundPublisher가 요구하는 producer 인터페이스만 stub — 발행분을 기록."""

    def __init__(self) -> None:
        self.emitted: list[dict] = []

    def emit(self, topic: str, partition: int, message: dict, key: str | None = None) -> None:
        self.emitted.append({"topic": topic, "partition": partition, "msg": message, "key": key})

    def emit_keyed(self, topic: str, partition: int, key: str, message: dict) -> None:
        self.emitted.append({"topic": topic, "partition": partition, "msg": message, "key": key})


def no_msg(oid: str, side: str, price: str, qty: str, *, user: str = "taker") -> dict:
    """LIMIT IOC 주문 메시지 dict (trade-replay 봇이 보내는 형태)."""
    return {
        "op": OP_NEW_ORDER,
        "id": oid,
        "u": user,
        "s": "ZECUSDT",
        "t": OrderType.LIMIT.value,
        "sd": side,
        "tif": TimeInForce.IOC.value,
        "p": str(n(price)),
        "oq": str(n(qty)),
        "oqq": "0",
    }


def co_msg(oid: str) -> dict:
    return {"op": OP_CANCEL_ORDER, "id": oid, "u": "taker", "s": "ZECUSDT"}


def feed(lane: Lane, out: OutboundPublisher, engine: MatchEngine, offset: int, value: dict,
         boot_hw: dict[int, int]) -> bool:
    """main.py:144-171 가드+디스패치 사본. 처리하면 True, skip하면 False."""
    if lane.last_offset >= 0:
        if offset <= lane.last_offset:
            return False
    elif offset < boot_hw.get(lane.partition, 0):
        return False

    op = op_of(value)
    if op == OP_NEW_ORDER:
        taker = NewOrderMsg.from_dict(value).to_order()
        result = engine.submit_new_order(lane.book, taker)
        out.publish_trades(lane, result.trades)
        out.publish_orders(lane, result.updated_orders)
        out.publish_book_diff(lane)
    elif op == OP_CANCEL_ORDER:
        cancel = CancelOrderMsg.from_dict(value)
        order = engine.submit_cancel_order(lane.book, cancel.id)
        if order is not None:
            out.publish_orders(lane, [order])
        out.publish_book_diff(lane)

    lane.last_offset = offset
    lane.dirty = True
    return True


@pytest.fixture
def engine() -> MatchEngine:
    return MatchEngine()


@pytest.fixture
def restored_lane(engine) -> Lane:
    """09:17 스냅샷 복원 상태 재현: resting 매수/매도 + 높은 last_offset/seq, dirty clear."""
    lane = build_lane("spot", "ZECUSDT", 1, price_precision=2, qty_precision=3)
    # resting SELL maker id "ZID" @500, resting BUY @499 (stale ~10:14 book 축소판)
    engine.submit_new_order(
        lane.book,
        Order("ZID", "mm", "ZECUSDT", OrderType.LIMIT, OrderSide.SELL,
              TimeInForce.GTC, n("500"), n("1"), 0),
    )
    engine.submit_new_order(
        lane.book,
        Order("BID9", "mm", "ZECUSDT", OrderType.LIMIT, OrderSide.BUY,
              TimeInForce.GTC, n("499"), n("1"), 0),
    )
    lane.book.drain_dirty_levels()   # restore_into처럼 복원 dirty 제거
    lane.book.seq = 1_001_986        # 스냅샷 seq 복원
    lane.last_offset = 2_840_000     # 스냅샷 offset 복원
    lane.dirty = False
    return lane


# ---------- 1. 순수 메커니즘: colliding-id NEW 침묵 삼킴 ----------

def test_colliding_id_new_order_is_swallowed_without_emission(engine, restored_lane):
    """resting id와 충돌하는 fresh NEW(다른 주문 객체)는 발행 없이 사라진다.

    RED: 현재 코드는 빈 MatchResult → updated_orders 비어있음/상태변화 없음.
    GREEN: fix 후 REJECTED를 발행(실거래소 기준 duplicate order id).
    """
    book = restored_lane.book
    seq_before = book.seq

    # Kafka는 매번 새 객체를 역직렬화 — 같은 id "ZID"지만 완전히 다른 주문(BUY IOC).
    # 500.30이면 resting SELL@500과 cross → 정상이라면 체결 또는 만료로 반드시 발행.
    incoming = NewOrderMsg.from_dict(no_msg("ZID", OrderSide.BUY.value, "500.30", "1")).to_order()
    result = engine.submit_new_order(book, incoming)

    assert result.trades == []                       # duplicate는 매칭 안 함(의도 유지)
    assert book.seq == seq_before                    # 책 무변경(의도 유지)
    assert restored_lane.book.contains("ZID")        # resting 주문 유지

    # 핵심 회귀: 삼키지 말고 반드시 통지해야 한다. (RED: 아래 두 줄 실패)
    assert result.updated_orders == [incoming]
    assert incoming.status == OrderStatus.REJECTED


# ---------- 2. 메인루프 재생: offset 전진 + seq 정지 + colliding NO 무발행 ----------

def test_lane_stall_matches_live_evidence(engine, restored_lane):
    out = OutboundPublisher(RecordingProducer())
    boot_hw = {1: 2_840_000}
    off = 2_840_000

    # (a) unknown-id CO 홍수 — 엔진이 받은 적 없는 id들. no-op이지만 offset은 전진.
    for i in range(1, 11):
        off += 1
        assert feed(restored_lane, out, engine, off, co_msg(f"ghost-{i}"), boot_hw) is True

    assert restored_lane.last_offset == 2_840_010          # evidence 2: offset 전진
    assert restored_lane.book.seq == 1_001_986             # evidence 3: seq 정지
    assert out.producer.emitted == []                      # evidence 4: 무발행

    # (b) colliding-id fresh NO 하나 (resting "ZID"와 충돌).
    off += 1
    emitted_before = len(out.producer.emitted)
    assert feed(restored_lane, out, engine, off, no_msg("ZID", OrderSide.BUY.value, "500.30", "1"),
                boot_hw) is True

    assert restored_lane.last_offset == off                # 삼켜도 offset은 전진
    assert restored_lane.book.seq == 1_001_986             # 여전히 book 무변경
    assert restored_lane.book.contains("ZID")              # resting 주문 유지

    # 핵심 회귀: colliding NO에 대해 반드시 OU를 발행해야 한다. (RED: 무발행이라 실패)
    new = out.producer.emitted[emitted_before:]
    ous = [e for e in new if e["msg"].get("op") == "OU"]
    assert len(ous) == 1
    assert ous[0]["msg"]["id"] == "ZID"
    assert ous[0]["msg"]["st"] == OrderStatus.REJECTED.value
    assert ous[0]["partition"] == 1


# ---------- 3. 가드 확인: offset ≤ last_offset은 skip, fresh(>)는 처리 ----------

def test_guard_skips_replayed_offset_but_processes_fresh(engine, restored_lane):
    """producer retry/rewind(offset ≤ last_offset)는 가드가 정확히 skip — stall 원인 아님.
    가드는 op-무관이라 fresh NO를 삼킬 수 없음을 함께 확인."""
    out = OutboundPublisher(RecordingProducer())
    boot_hw = {1: 2_840_000}

    # 이미 처리한 구간의 재전송(rewind) — skip.
    assert feed(restored_lane, out, engine, 2_800_000,
                no_msg("replayed", OrderSide.BUY.value, "500.30", "1"), boot_hw) is False
    assert out.producer.emitted == []
    assert restored_lane.last_offset == 2_840_000          # 전진하지 않음

    # fresh offset의 fresh id NO — 가드 통과, 처리+발행. (no-cross @498 → 만료 OU 1건)
    assert feed(restored_lane, out, engine, 2_840_001,
                no_msg("fresh-1", OrderSide.BUY.value, "498", "1"), boot_hw) is True
    assert restored_lane.last_offset == 2_840_001
    ous = [e for e in out.producer.emitted if e["msg"].get("op") == "OU"]
    assert len(ous) == 1 and ous[0]["msg"]["id"] == "fresh-1"   # 삼켜지지 않음


# ---------- 4. 정상 경로 불변: fresh-id IOC는 체결/만료 모두 발행 ----------

def test_fresh_ioc_still_trades_and_emits(engine, restored_lane):
    """fix가 정상 IOC 경로를 건드리지 않음을 보장 — cross는 체결, no-cross는 만료 발행."""
    out = OutboundPublisher(RecordingProducer())
    boot_hw = {1: 2_840_000}

    # cross: fresh-id BUY IOC @500 vs resting SELL "ZID"@500 → 체결.
    assert feed(restored_lane, out, engine, 2_840_001,
                no_msg("cross", OrderSide.BUY.value, "500", "1"), boot_hw) is True
    ops = [e["msg"].get("op") for e in out.producer.emitted]
    assert "TR" in ops and "OU" in ops
    assert restored_lane.book.seq > 1_001_986              # 체결로 seq 전진
    assert not restored_lane.book.contains("ZID")          # resting maker 소진

    # no-cross: fresh-id BUY IOC @498 (asks 없음) → 만료(CANCELED) 발행.
    out.producer.emitted.clear()
    assert feed(restored_lane, out, engine, 2_840_002,
                no_msg("expire", OrderSide.BUY.value, "498", "1"), boot_hw) is True
    ous = [e for e in out.producer.emitted if e["msg"].get("op") == "OU"]
    assert len(ous) == 1 and ous[0]["msg"]["st"] == OrderStatus.CANCELED.value
