"""control 토픽 — parse + 부팅 흡수(latest-per-symbol). Kafka 없이 스텁으로 검증."""

import orjson

from messaging.control import TickerAdd, parse_control, read_control_defs
from messaging.topics import CONTROL_PARTITION, OP_ADD_TICKER, control_topic


class StubMsg:
    def __init__(self, offset, key=None, value=None, error=None):
        self._offset = offset
        self._key = key.encode() if isinstance(key, str) else key
        self._value = orjson.dumps(value) if isinstance(value, dict) else value
        self._error = error

    def offset(self):
        return self._offset

    def key(self):
        return self._key

    def value(self):
        return self._value

    def error(self):
        return self._error


class StubConsumer:
    def __init__(self, messages=(), watermarks=None):
        self._messages = list(messages)
        self._watermarks = watermarks or {}
        self.assignments = []

    def watermarks(self, topic, partition):
        return self._watermarks.get((topic, partition), (0, 0))

    def assign(self, assignments):
        self.assignments.append(list(assignments))

    def poll(self, timeout=1.0):
        return self._messages.pop(0) if self._messages else None


def _add(symbol, partition, pp, qp):
    return {
        "op": OP_ADD_TICKER,
        "symbol": symbol,
        "partition": partition,
        "pricePrecision": pp,
        "qtyPrecision": qp,
    }


def test_parse_control_add_and_garbage():
    assert parse_control(orjson.dumps(_add("BTCUSDT", 0, 2, 5)))[0] == OP_ADD_TICKER
    assert parse_control(b"not json") is None
    assert parse_control(orjson.dumps({"symbol": "X"})) is None  # op 누락
    assert parse_control(None) is None


def test_read_control_defs_latest_per_symbol():
    topic = control_topic("spot")
    msgs = [
        StubMsg(0, key="BTCUSDT", value=_add("BTCUSDT", 0, 2, 5)),
        StubMsg(1, key="ETHUSDT", value=_add("ETHUSDT", 2, 2, 3)),
        StubMsg(2, key="BTCUSDT", value=_add("BTCUSDT", 0, 1, 4)),  # 같은 key 최신 채택
    ]
    consumer = StubConsumer(messages=msgs, watermarks={(topic, CONTROL_PARTITION): (0, 3)})

    defs, hw = read_control_defs(consumer, "spot")

    assert hw == 3
    assert set(defs) == {"BTCUSDT", "ETHUSDT"}
    assert defs["BTCUSDT"] == TickerAdd("BTCUSDT", 0, 4)  # offset 2가 최신
    # 처음부터(low=0) 읽도록 assign
    assert consumer.assignments[0] == [(topic, CONTROL_PARTITION, 0)]


def test_read_control_defs_empty_topic():
    topic = control_topic("futures")
    consumer = StubConsumer(messages=[], watermarks={(topic, CONTROL_PARTITION): (0, 0)})

    defs, hw = read_control_defs(consumer, "futures")

    assert defs == {} and hw == 0
    assert consumer.assignments == []  # 빈 토픽은 assign 안 함
