"""Match engine entrypoint.

Config 파일이 부팅 시드, control 토픽이 런타임 상장 소스 — 둘을 합쳐 ticker별 Lane 구성.
단일 consumer 루프로 메시지 key(symbol) 라우팅. Lane 단위 격리, 1 인스턴스 N ticker.
여러 ticker가 한 partition 버킷을 공유하므로 partition이 아닌 key로 lane을 찾는다.
inbound 토픽이 WAL — 부팅 시 state 스냅샷 복원 후, 이미 반영된/빈 책의 과거 메시지는
skip하고 일반 처리. control 토픽 add는 부팅 시 흡수 + 라이브 수신으로 lane을 즉시 추가.
"""

import gc
import os
import signal

import orjson
from dotenv import load_dotenv

from engine.lane import LaneRegistry, build_lane
from engine.matcher import MatchEngine, now_ms
from messaging.consumer import KafkaConsumerWrapper
from messaging.control import TickerAdd, parse_control, read_control_defs
from messaging.outbound import OutboundPublisher
from messaging.producer import KafkaProducerWrapper
from messaging.snapshot_store import SnapshotStore
from messaging.topics import (
    CONTROL_PARTITION,
    OP_ADD_TICKER,
    OP_CANCEL_ORDER,
    OP_NEW_ORDER,
    control_topic,
)
from schemas.messages import CancelOrderMsg, NewOrderMsg, op_of

load_dotenv()

GC_IDLE_TICKS = 5  # 연속 유휴 poll 횟수 — 이만큼 한가하면 cyclic GC를 유휴 시간에 수행


def env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _add_lane_live(
    registry: LaneRegistry,
    market: str,
    add: TickerAdd,
    assigned_in: set[tuple[str, int]],
) -> None:
    """control 토픽 add를 런타임에 반영 — lane in-memory insert(빈 책, Kafka 재배정 없음)."""
    lane = build_lane(market, add.symbol, add.partition, add.qty_precision)
    if not registry.add(lane):
        return  # 이미 존재(부팅 흡수분/중복)
    lane.last_snapshot_ms = now_ms()
    if (lane.topic_in, lane.partition) in assigned_in:
        print(f"lane added live: {market}:{add.symbol} (partition {add.partition})")
    else:
        # 빈 버킷 edge: 부팅 시 lane이 하나도 없던 partition은 assign되지 않음.
        # P=6에 심볼이 고루 차 있으면 발생하지 않음 — 발생 시 재시작으로 활성화.
        print(
            f"WARNING: {market}:{add.symbol} partition {add.partition} not assigned at boot — "
            f"inactive until engine restart (empty bucket edge)"
        )


def main() -> None:
    broker = env("KAFKA_BROKER")
    config_path = env("MATCH_CONFIG_PATH")

    registry = LaneRegistry.load(config_path)
    markets = registry.markets()  # config가 단일/다중 market 모두 지원

    consumer = KafkaConsumerWrapper(broker=broker, group_id="bitshuriken-match")
    producer = KafkaProducerWrapper(broker=broker)
    store = SnapshotStore(consumer, producer)
    out = OutboundPublisher(producer)

    # control 토픽(부팅): market별로 처음부터 흡수해 config seed 위에 런타임 추가분 보강.
    # 라이브 소비는 각 ctrl_hw부터 이어감. control 토픽이 없으면 skip.
    control_topics: dict[str, str] = {}  # topic -> market
    extra_assignments: list[tuple[str, int, int]] = []
    for m in markets:
        try:
            ctrl_defs, ctrl_hw = read_control_defs(consumer, m)
        except Exception as e:  # 토픽 부재 등 — 해당 market은 동적 상장 없이 진행
            print(f"control topic skipped for market={m}: {e}")
            continue
        for add in ctrl_defs.values():
            registry.add(
                build_lane(m, add.symbol, add.partition, add.qty_precision)
            )
        control_topics[control_topic(m)] = m
        extra_assignments.append((control_topic(m), CONTROL_PARTITION, ctrl_hw))

    lanes = registry.all()
    engine = MatchEngine()

    # 스냅샷 복원 + inbound 시작 offset 셋. control 파티션들도 같은 assign에 묶어 라이브 유지.
    boot_hw = store.restore(lanes, extra_assignments=extra_assignments)
    store.init_schedule(lanes)
    assigned_in = {(lane.topic_in, lane.partition) for lane in lanes}

    # GC STW 방지: 자동 cyclic GC를 끄고(refcount는 유지) 복구 직후 장수 객체를 freeze.
    # 순환 수거는 유휴 틈에만 수동 실행.
    gc.collect()
    gc.freeze()
    gc.disable()

    print(f"match started, markets={markets}, lanes={registry.symbols()}")

    # SIGTERM 기본 동작은 즉사라 finally가 실행되지 않는다 — 핸들러로 루프를 빠져나와
    # 최종 스냅샷+flush를 보장한다 (unclean stop이 dirty book을 WAL replay에만 맡기던 갭).
    stopping = {"flag": False}

    def _request_stop(signum: int, _frame: object) -> None:
        stopping["flag"] = True
        print(f"signal {signum} — draining for final snapshot…")

    signal.signal(signal.SIGTERM, _request_stop)
    signal.signal(signal.SIGINT, _request_stop)

    idle_ticks = 0
    try:
        while not stopping["flag"]:
            msg = consumer.poll(1.0)
            if msg is None:
                store.publish_due(lanes)
                idle_ticks += 1
                if idle_ticks >= GC_IDLE_TICKS:
                    gc.collect()
                    idle_ticks = 0
                continue
            idle_ticks = 0
            if msg.error():
                print(f"consumer error: {msg.error()}")
                continue

            # control 토픽: 런타임 상장(add). 주문 skip 로직 이전에 분기.
            ctrl_market = control_topics.get(msg.topic())
            if ctrl_market is not None:
                parsed = parse_control(msg.value())
                if parsed is not None and parsed[0] == OP_ADD_TICKER:
                    _add_lane_live(
                        registry, ctrl_market, TickerAdd.from_dict(parsed[1]), assigned_in
                    )
                continue

            key = msg.key().decode() if msg.key() else None
            lane = registry.get(key)
            if lane is None:
                print(f"no lane for key={key} ({msg.topic()}/{msg.partition()})")
                continue

            # 복구 시 이미 반영된(스냅샷 lane) / 빈 책의 과거(가짜 매칭 방지) 메시지는 skip.
            if lane.last_offset >= 0:
                if msg.offset() <= lane.last_offset:
                    continue
            elif msg.offset() < boot_hw.get(msg.partition(), 0):
                continue

            data: dict = orjson.loads(msg.value())
            op = op_of(data)

            if op == OP_NEW_ORDER:
                taker = NewOrderMsg.from_dict(data).to_order()
                result = engine.submit_new_order(lane.book, taker)
                out.publish_trades(lane, result.trades)
                out.publish_orders(lane, result.updated_orders)
                out.publish_book_diff(lane)
            elif op == OP_CANCEL_ORDER:
                cancel = CancelOrderMsg.from_dict(data)
                order = engine.submit_cancel_order(lane.book, cancel.id)
                if order is not None:
                    out.publish_orders(lane, [order])
                out.publish_book_diff(lane)
            else:
                print(f"unknown op: {op}")

            lane.last_offset = msg.offset()
            lane.dirty = True
            # 트래픽이 끊기지 않는 lane도 30s 상한을 지키도록 메시지 처리 후에도 체크
            store.publish_due(lanes)
    finally:
        store.publish_all_dirty(registry.all())  # 라이브 상장 lane 포함
        producer.flush()
        consumer.close()
        print("match stopped clean (final snapshots published)")


if __name__ == "__main__":
    main()
