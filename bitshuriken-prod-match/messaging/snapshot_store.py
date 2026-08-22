"""Lane 스냅샷의 발행과 부팅 복원 — state 토픽 계약의 양면.

발행: dirty lane을 interval 간격으로 (book 상태 + 마지막 inbound offset) 원자 저장.
복원: state 토픽을 처음부터 읽어 key별 최신 메시지 채택 후 inbound offset 셋.
consumer/producer는 duck-typing — 테스트에서 스텁으로 대체 가능.
"""

import orjson
from confluent_kafka import OFFSET_BEGINNING, OFFSET_END

from engine.lane import Lane
from engine.matcher import now_ms
from schemas.snapshot import SnapshotMsg

SNAPSHOT_INTERVAL_MS = 30_000  # dirty lane의 스냅샷 최소 간격


class SnapshotStore:
    def __init__(self, consumer, producer, interval_ms: int = SNAPSHOT_INTERVAL_MS) -> None:
        self.consumer = consumer
        self.producer = producer
        self.interval_ms = interval_ms

    # ---------- 부팅 복원 ----------

    def restore(
        self,
        lanes: list[Lane],
        extra_assignments: list[tuple[str, int, int]] | None = None,
    ) -> dict[int, int]:
        """lane별 마지막 스냅샷을 복원하고 inbound 시작 offset을 셋한다.

        여러 lane이 한 partition을 공유하므로, partition별 assign offset = 그 partition의
        스냅샷 lane들 중 min(last_offset+1). 스냅샷 lane이 없으면 OFFSET_END(전부 빈 책).
        스냅샷 있는 lane은 offset+1부터 replay (이미 반영된 메시지는 핫루프가 skip).

        extra_assignments: inbound 외에 같은 consumer에 묶을 (topic, partition, offset) — 예: control 토픽.
        assign은 전체 교체라 control도 여기서 함께 묶어야 라이브 소비가 유지된다.

        반환: partition -> boot high-watermark. 빈 책 lane이 같은 partition의 과거를
        replay하지 않도록(가짜 매칭 방지) 핫루프가 skip 기준으로 쓴다.
        """
        self._restore_books(lanes)

        by_in_partition: dict[tuple[str, int], list[Lane]] = {}
        for lane in lanes:
            by_in_partition.setdefault((lane.topic_in, lane.partition), []).append(lane)

        assignments: list[tuple[str, int, int]] = []
        boot_hw: dict[int, int] = {}
        for (topic, partition), plist in by_in_partition.items():
            low, high = self.consumer.watermarks(topic, partition)
            boot_hw[partition] = high
            snap_lanes = [lane for lane in plist if lane.last_offset >= 0]
            if snap_lanes:
                start = max(min(lane.last_offset + 1 for lane in snap_lanes), low)
            else:
                start = OFFSET_END
            assignments.append((topic, partition, start))

        if extra_assignments:
            assignments.extend(extra_assignments)

        self.consumer.assign(assignments)
        return boot_hw

    def _restore_books(self, lanes: list[Lane]) -> None:
        """state 토픽을 처음부터 읽어 lane별 마지막 스냅샷을 복원한다.

        한 state partition에 여러 symbol이 섞이므로 key로 lane을 찾는다.
        compaction은 lazy이므로 같은 key의 마지막 메시지를 채택.
        """
        by_state: dict[tuple[str, int], dict[str, Lane]] = {}
        for lane in lanes:
            by_state.setdefault((lane.topic_state, lane.partition), {})[lane.book.symbol] = lane

        pending: dict[tuple[str, int], int] = {}  # state (topic, partition) -> high watermark
        for tp in by_state:
            _low, high = self.consumer.watermarks(*tp)
            if high > 0:
                pending[tp] = high

        if not pending:
            return

        self.consumer.assign([(topic, partition, OFFSET_BEGINNING) for topic, partition in pending])

        latest: dict[tuple[str, int, str], dict] = {}  # (topic, partition, symbol) -> snapshot
        idle = 0
        while pending:
            msg = self.consumer.poll(1.0)
            if msg is None:
                idle += 1
                if idle >= 30:
                    raise RuntimeError(f"state restore stalled, pending={list(pending)}")
                continue
            if msg.error():
                print(f"state consumer error: {msg.error()}")
                continue

            idle = 0
            tp = (msg.topic(), msg.partition())
            lanes_here = by_state.get(tp)
            if lanes_here is not None:
                key: str | None = msg.key().decode() if msg.key() else None
                if key in lanes_here:
                    latest[(tp[0], tp[1], key)] = orjson.loads(msg.value())
            if tp in pending and msg.offset() >= pending[tp] - 1:
                del pending[tp]

        for (topic, partition, symbol), data in latest.items():
            lane = by_state[(topic, partition)][symbol]
            snap = SnapshotMsg.from_dict(data)
            snap.restore_into(lane.book)
            lane.last_offset = snap.offset
            print(
                f"restored {lane.book.symbol} from snapshot: "
                f"offset={snap.offset} seq={snap.seq}"
            )

    # ---------- 주기 발행 ----------

    def init_schedule(self, lanes: list[Lane]) -> None:
        """초기 due 시각을 lane별로 분산 — 동시 스냅샷(일시정지 합산) 방지."""
        boot_ms = now_ms()
        for i, lane in enumerate(lanes):
            lane.last_snapshot_ms = boot_ms - (i * self.interval_ms) // max(len(lanes), 1)

    def publish_due(self, lanes: list[Lane]) -> None:
        """메시지 처리 사이에 호출 — 상태+offset 원자 저장.

        호출당 최대 1개 lane만 발행해 일시정지 상한을 책 1개 직렬화로 제한.
        발행 실패는 매칭을 멈추지 않는다 — 복구는 마지막 성공 스냅샷 + WAL replay로 여전히 정확.
        """
        now = now_ms()
        for lane in lanes:
            if not lane.dirty or now - lane.last_snapshot_ms < self.interval_ms:
                continue
            try:
                snap = SnapshotMsg.from_book(lane.book, lane.last_offset)
                self.producer.emit_keyed(
                    lane.topic_state, lane.partition, lane.book.symbol, snap.to_dict()
                )
                lane.dirty = False
            except Exception as e:  # 예: 메시지 크기 초과 — 30s 후 재시도, 그때까지 error 반복
                print(f"snapshot publish failed: {lane.book.symbol}: {e}")
            lane.last_snapshot_ms = now
            elapsed = now_ms() - now
            if elapsed > 20:
                print(
                    f"snapshot slow: {lane.book.symbol} took {elapsed}ms (orders may be piling up)"
                )
            break
