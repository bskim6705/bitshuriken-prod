"""컨트롤 토픽: 런타임 ticker 상장. compacted, key=symbol, 1 partition.

부팅 시 처음부터 HW까지 읽어 config seed lane을 보강하고, 이후 라이브로 add를 수신한다.
컴팩션 토픽이라 재시작해도 추가분이 보존된다(JSON config에 없어도 무방).
"""

from dataclasses import dataclass

import orjson

from messaging.topics import CONTROL_PARTITION, OP_ADD_TICKER, control_topic

_IDLE_BREAK = 10  # 연속 빈 poll — 컴팩션으로 HW 직전이 비어도 부팅이 멈추지 않게 graceful break


@dataclass(slots=True)
class TickerAdd:
    symbol: str
    partition: int
    qty_precision: int

    @classmethod
    def from_dict(cls, d: dict) -> "TickerAdd":
        return cls(
            symbol=d["symbol"],
            partition=int(d["partition"]),
            qty_precision=int(d["qtyPrecision"]),
        )


def parse_control(value: bytes | None) -> tuple[str, dict] | None:
    """(op, data) 반환. 파싱 불가/op 누락이면 None."""
    if not value:
        return None
    try:
        data = orjson.loads(value)
    except orjson.JSONDecodeError:
        return None
    op = data.get("op")
    if not op:
        return None
    return op, data


def read_control_defs(consumer, market: str) -> tuple[dict[str, TickerAdd], int]:
    """컨트롤 토픽을 처음부터 HW까지 읽어 symbol별 최신 add를 모은다.

    반환: ({symbol -> TickerAdd}, hw). 라이브 소비는 이 hw부터 이어간다(부팅과 라이브 사이 갭 없음).
    토픽이 비었으면 ({}, hw).
    """
    topic = control_topic(market)
    low, high = consumer.watermarks(topic, CONTROL_PARTITION)
    if high <= low:
        return {}, high

    consumer.assign([(topic, CONTROL_PARTITION, low)])
    defs: dict[str, TickerAdd] = {}
    last = low - 1
    idle = 0
    while last < high - 1:
        msg = consumer.poll(1.0)
        if msg is None:
            idle += 1
            if idle >= _IDLE_BREAK:
                print(f"control restore: idle break at offset {last} (hw={high})")
                break
            continue
        if msg.error():
            print(f"control consumer error: {msg.error()}")
            continue
        idle = 0
        last = msg.offset()
        parsed = parse_control(msg.value())
        if parsed is None:
            continue
        op, data = parsed
        if op == OP_ADD_TICKER:
            add = TickerAdd.from_dict(data)
            defs[add.symbol] = add  # compaction lazy — 같은 key 최신 채택
    return defs, high
