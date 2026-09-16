"""Lane: 1 ticker에 대응하는 입출력 토픽 + OrderBook 묶음.

LaneRegistry가 config(tickers.json)에서 Lane들을 만든다. 라우팅은 symbol 기준
(여러 ticker가 한 partition 버킷을 공유하므로 partition으로는 식별 불가). partition은
produce 대상 버킷일 뿐이다.
"""

import json
from dataclasses import dataclass

from engine.orderbook import OrderBook
from messaging.topics import book_topic, inbound_topic, outbound_topic, state_topic

SCALE = 10**8


@dataclass(slots=True)
class Lane:
    """1 ticker에 대응하는 입출력 + OrderBook 묶음."""

    topic_in: str
    topic_out: str
    topic_book: str  # depth diff publish용
    topic_state: str  # 스냅샷 publish용 (log-compacted)
    partition: int  # produce 버킷 (0..P-1). 여러 lane이 공유 가능
    book: OrderBook
    last_offset: int = -1  # 마지막 처리한 inbound offset. -1 = 처리 이력 없음
    dirty: bool = False  # 마지막 스냅샷 이후 변경 여부
    last_snapshot_ms: int = 0


def build_lane(
    market: str, symbol: str, partition: int, qty_precision: int
) -> Lane:
    """ticker 메타로 Lane 1개 구성 — config 로드와 런타임 추가가 공유."""
    book = OrderBook(
        symbol=symbol,
        qty_step=SCALE // (10**qty_precision),
    )
    return Lane(
        topic_in=inbound_topic(market),
        topic_out=outbound_topic(market),
        topic_book=book_topic(market),
        topic_state=state_topic(market),
        partition=partition,
        book=book,
    )


class LaneRegistry:
    """symbol -> Lane 매핑. 순서는 정의 순서 유지. 런타임 add 가능."""

    def __init__(self, lanes: list[Lane]) -> None:
        self._lanes = lanes
        self._by_symbol: dict[str, Lane] = {lane.book.symbol: lane for lane in lanes}

    @classmethod
    def load(cls, path: str) -> "LaneRegistry":
        """tickers config(JSON)를 읽어 부팅 시드 lane 집합을 만든다."""
        with open(path) as f:
            config = json.load(f)

        lanes = [
            build_lane(
                t["market"], t["symbol"], t["partition"], t["qtyPrecision"]
            )
            for t in config["tickers"]
        ]
        return cls(lanes)

    def markets(self) -> list[str]:
        """config에 등장한 market 슬러그(정의 순서, 중복 제거). control 토픽 소비 대상."""
        seen: list[str] = []
        for lane in self._lanes:
            m = lane.topic_in.split(".")[1]  # match.<market>.in
            if m not in seen:
                seen.append(m)
        return seen

    def add(self, lane: Lane) -> bool:
        """런타임 신규 상장. 이미 있으면 False(무시), 추가했으면 True.

        _lanes는 main의 lanes 참조와 동일 객체라 append 시 스냅샷 스케줄에도 즉시 반영.
        """
        symbol = lane.book.symbol
        if symbol in self._by_symbol:
            return False
        self._lanes.append(lane)
        self._by_symbol[symbol] = lane
        return True

    def get(self, symbol: str | None) -> Lane | None:
        if symbol is None:
            return None
        return self._by_symbol.get(symbol)

    def all(self) -> list[Lane]:
        return self._lanes

    def symbols(self) -> list[str]:
        return list(self._by_symbol.keys())

    def __len__(self) -> int:
        return len(self._lanes)
