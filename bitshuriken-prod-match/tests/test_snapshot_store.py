"""SnapshotStore 발행/복원 — Kafka 없이 duck-typing 스텁으로 검증.

consumer 스텁은 준비된 메시지 시퀀스를 poll로 반환, producer 스텁은 emit_keyed를 기록.
"""

import json

import pytest
from confluent_kafka import OFFSET_BEGINNING, OFFSET_END

import messaging.snapshot_store as snapshot_store_module
from engine.lane import Lane
from engine.matcher import now_ms
from engine.order import Order, OrderSide, OrderType, TimeInForce
from engine.orderbook import OrderBook
from messaging.snapshot_store import SnapshotStore
from schemas.snapshot import SnapshotMsg

SCALE = 10**8
STATE = "match.spot.state"
INBOUND = "match.spot.in"


# ---------- 스텁 ----------


class StubMsg:
    def __init__(self, topic=STATE, partition=0, offset=0, key=None, value=None, error=None):
        self._topic, self._partition, self._offset = topic, partition, offset
        self._key = key.encode() if isinstance(key, str) else key
        self._value = json.dumps(value) if isinstance(value, dict) else value
        self._error = error

    def topic(self):
        return self._topic

    def partition(self):
        return self._partition

    def offset(self):
        return self._offset

    def key(self):
        return self._key

    def value(self):
        return self._value

    def error(self):
        return self._error


class StubConsumer:
    """poll이 준비된 메시지를 순서대로 반환, 소진 후 None. assign 호출을 기록."""

    def __init__(self, messages=(), watermarks=None):
        self._messages = list(messages)
        self._watermarks = watermarks or {}
        self.assignments: list[list[tuple[str, int, int]]] = []

    def watermarks(self, topic, partition):
        return self._watermarks.get((topic, partition), (0, 0))

    def assign(self, assignments):
        self.assignments.append(list(assignments))

    def poll(self, timeout=1.0):
        return self._messages.pop(0) if self._messages else None


class StubProducer:
    def __init__(self, fail=False):
        self.fail = fail
        self.keyed: list[tuple[str, int, str, dict]] = []

    def emit_keyed(self, topic, partition, key, message):
        if self.fail:
            raise RuntimeError("boom")
        self.keyed.append((topic, partition, key, message))


# ---------- 헬퍼 ----------


def make_lane(symbol="BTCUSDT", partition=0) -> Lane:
    book = OrderBook(symbol=symbol, partition=partition, qty_step=10**3, price_tick=10**6)
    return Lane(
        topic_in=INBOUND,
        topic_out="match.spot.out",
        topic_book="match.spot.book",
        topic_state=STATE,
        partition=partition,
        book=book,
    )


def resting(oid: str, side: OrderSide, price: int, qty: int) -> Order:
    return Order(
        id=oid,
        user_id="u1",
        symbol="BTCUSDT",
        type=OrderType.LIMIT,
        side=side,
        time_in_force=TimeInForce.GTC,
        price=price * SCALE,
        orig_qty=qty,
        orig_quote_qty=0,
    )


def snapshot_of(orders: list[Order], offset: int) -> SnapshotMsg:
    """별도 book에 주문을 쌓아 스냅샷 생성 — 복원 비교 기준."""
    book = OrderBook(symbol="BTCUSDT", partition=0, qty_step=10**3, price_tick=10**6)
    for o in orders:
        book.add(o)
    return SnapshotMsg.from_book(book, offset)


def make_due(lane: Lane) -> None:
    lane.dirty = True
    lane.last_snapshot_ms = now_ms() - 31_000


# ---------- 스냅샷 due 판정 ----------


def test_due_lane_publishes_state_with_offset():
    producer = StubProducer()
    store = SnapshotStore(StubConsumer(), producer)
    lane = make_lane()
    lane.book.add(resting("b1", OrderSide.BUY, 100, 50_000))
    lane.last_offset = 42
    make_due(lane)

    store.publish_due([lane])

    assert len(producer.keyed) == 1
    topic, partition, key, message = producer.keyed[0]
    assert (topic, partition, key) == (STATE, 0, "BTCUSDT")
    assert message == SnapshotMsg.from_book(lane.book, 42).to_dict()  # 상태+offset 원자 저장
    assert lane.dirty is False


def test_not_due_before_interval():
    producer = StubProducer()
    store = SnapshotStore(StubConsumer(), producer)
    lane = make_lane()
    lane.dirty = True
    lane.last_snapshot_ms = now_ms()  # 방금 스냅샷

    store.publish_due([lane])

    assert producer.keyed == []
    assert lane.dirty is True


def test_clean_lane_not_published():
    producer = StubProducer()
    store = SnapshotStore(StubConsumer(), producer)
    lane = make_lane()
    lane.dirty = False
    lane.last_snapshot_ms = now_ms() - 31_000

    store.publish_due([lane])

    assert producer.keyed == []


def test_at_most_one_lane_per_call():
    producer = StubProducer()
    store = SnapshotStore(StubConsumer(), producer)
    a, b = make_lane("AAAUSDT", 0), make_lane("BBBUSDT", 1)
    make_due(a)
    make_due(b)

    store.publish_due([a, b])
    assert [k for _, _, k, _ in producer.keyed] == ["AAAUSDT"]

    store.publish_due([a, b])  # 다음 호출에서 나머지 lane 발행
    assert [k for _, _, k, _ in producer.keyed] == ["AAAUSDT", "BBBUSDT"]


def test_init_schedule_staggers_due_times(monkeypatch):
    monkeypatch.setattr(snapshot_store_module, "now_ms", lambda: 1_000_000)
    store = SnapshotStore(StubConsumer(), StubProducer(), interval_ms=30_000)
    lanes = [make_lane(f"S{i}USDT", i) for i in range(3)]

    store.init_schedule(lanes)

    # boot - (i * interval) // n — lane별 due 시각 분산
    assert [lane.last_snapshot_ms for lane in lanes] == [1_000_000, 990_000, 980_000]


def test_publish_failure_does_not_raise_and_retries_after_interval(capsys):
    producer = StubProducer(fail=True)
    store = SnapshotStore(StubConsumer(), producer)
    lane = make_lane()
    lane.last_offset = 7
    make_due(lane)

    store.publish_due([lane])  # 예외 전파 없음 — 매칭 비중단

    assert producer.keyed == []
    assert lane.dirty is True  # 다음 due에 재시도
    assert now_ms() - lane.last_snapshot_ms < 1_000  # 재시도는 interval 후로 예약
    assert "snapshot publish failed" in capsys.readouterr().out

    producer.fail = False
    make_due(lane)
    store.publish_due([lane])
    assert len(producer.keyed) == 1
    assert lane.dirty is False


def test_slow_snapshot_warns(monkeypatch, capsys):
    times = iter([1_000_000, 1_000_025])  # 발행에 25ms 소요된 상황
    monkeypatch.setattr(snapshot_store_module, "now_ms", lambda: next(times))
    store = SnapshotStore(StubConsumer(), StubProducer())
    lane = make_lane()
    lane.dirty = True
    lane.last_snapshot_ms = 0

    store.publish_due([lane])

    assert "snapshot slow" in capsys.readouterr().out


# ---------- 부팅 복원 ----------


def test_restore_adopts_latest_message_per_key(capsys):
    old = snapshot_of([resting("b1", OrderSide.BUY, 100, 50_000)], offset=3)
    new = snapshot_of(
        [resting("b1", OrderSide.BUY, 100, 50_000), resting("a1", OrderSide.SELL, 101, 20_000)],
        offset=9,
    )
    consumer = StubConsumer(
        messages=[
            StubMsg(error="broker hiccup"),  # error 메시지는 건너뛴다
            StubMsg(offset=0, key="BTCUSDT", value=old.to_dict()),
            StubMsg(offset=1, key="OTHER", value=old.to_dict()),  # 다른 key는 미채택
            StubMsg(offset=2, key="BTCUSDT", value=new.to_dict()),
        ],
        watermarks={(STATE, 0): (0, 3)},
    )
    store = SnapshotStore(consumer, StubProducer())
    lane = make_lane()

    store.restore([lane])

    # compaction lazy — 같은 key의 마지막 메시지 채택
    assert SnapshotMsg.from_book(lane.book, 9).to_dict() == new.to_dict()
    assert lane.last_offset == 9
    assert consumer.assignments[0] == [(STATE, 0, OFFSET_BEGINNING)]
    assert consumer.assignments[1] == [(INBOUND, 0, 10)]  # 스냅샷 offset+1부터 replay
    assert "state consumer error" in capsys.readouterr().out


def test_restore_without_snapshot_assigns_offset_end():
    consumer = StubConsumer(watermarks={(STATE, 0): (0, 0)})  # state 토픽 비어 있음
    store = SnapshotStore(consumer, StubProducer())
    lane = make_lane()

    store.restore([lane])

    assert lane.last_offset == -1
    assert SnapshotMsg.from_book(lane.book, 0).to_dict() == snapshot_of([], 0).to_dict()  # 빈 책
    assert consumer.assignments == [[(INBOUND, 0, OFFSET_END)]]  # 최신부터 — 가짜 매칭 방지


def test_restore_mixed_lanes_offsets():
    snap = snapshot_of([resting("b1", OrderSide.BUY, 100, 50_000)], offset=5)
    consumer = StubConsumer(
        messages=[StubMsg(partition=0, offset=0, key="BTCUSDT", value=snap.to_dict())],
        watermarks={(STATE, 0): (0, 1), (STATE, 1): (0, 0)},
    )
    store = SnapshotStore(consumer, StubProducer())
    with_snap, without_snap = make_lane("BTCUSDT", 0), make_lane("ETHUSDT", 1)

    store.restore([with_snap, without_snap])

    assert with_snap.last_offset == 5
    assert without_snap.last_offset == -1
    assert consumer.assignments[-1] == [(INBOUND, 0, 6), (INBOUND, 1, OFFSET_END)]


def test_restore_stall_raises_runtime_error():
    consumer = StubConsumer(messages=[], watermarks={(STATE, 0): (0, 5)})  # 메시지가 오지 않음
    store = SnapshotStore(consumer, StubProducer())

    with pytest.raises(RuntimeError, match="state restore stalled"):
        store.restore([make_lane()])


def test_restore_shared_partition_min_offset_and_boot_hw():
    """한 partition을 스냅샷 lane + 빈 책 lane이 공유 — assign은 스냅샷의 min(offset+1),
    빈 책 lane이 OFFSET_END로 끌어올리지 않는다. boot_hw로 빈 책의 과거 skip 기준 반환."""
    snap = snapshot_of([resting("b1", OrderSide.BUY, 100, 50_000)], offset=5)
    consumer = StubConsumer(
        messages=[StubMsg(partition=0, offset=0, key="BTCUSDT", value=snap.to_dict())],
        watermarks={(STATE, 0): (0, 1), (INBOUND, 0): (0, 100)},
    )
    store = SnapshotStore(consumer, StubProducer())
    with_snap, empty = make_lane("BTCUSDT", 0), make_lane("ETHUSDT", 0)  # 같은 버킷 0

    boot_hw = store.restore([with_snap, empty])

    assert with_snap.last_offset == 5
    assert empty.last_offset == -1
    # 빈 책 lane이 같은 partition이어도 스냅샷 offset+1부터 (min). OFFSET_END 아님.
    assert consumer.assignments[-1] == [(INBOUND, 0, 6)]
    assert boot_hw == {0: 100}  # 핫루프가 빈 책 lane의 < 100 메시지를 skip하는 기준
