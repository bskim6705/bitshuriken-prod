"""Lane 상태 스냅샷 직렬화/역직렬화.

match.{market}.state (log-compacted, key=symbol)에 lane당 1메시지.
bids/asks 배열 순서 = 가격레벨 순 + 레벨 내 FIFO. 복원 시 그대로 add하면
OrderedDict 삽입 순서로 FIFO가 유지된다.
"""

from dataclasses import dataclass

from engine.orderbook import OrderBook
from schemas.order_codec import OrderCodec


@dataclass(slots=True)
class SnapshotMsg:
    """Lane 스냅샷: book 상태 + 마지막 처리 inbound offset.

    tid는 (makerOrderId, takerOrderId)에서 결정되므로 별도 카운터를 싣지 않는다.
    """

    seq: int
    offset: int
    bids: list[dict]  # Order 전 필드, int * 10^8은 string
    asks: list[dict]

    @classmethod
    def from_book(cls, book: OrderBook, offset: int) -> "SnapshotMsg":
        bids = [OrderCodec.to_dict(o) for _, level in book.get_bid_levels() for o in level.values()]
        asks = [OrderCodec.to_dict(o) for _, level in book.get_ask_levels() for o in level.values()]
        return cls(
            seq=book.seq,
            offset=offset,
            bids=bids,
            asks=asks,
        )

    def to_dict(self) -> dict:
        return {
            "seq": self.seq,
            "offset": self.offset,
            "bids": self.bids,
            "asks": self.asks,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SnapshotMsg":
        return cls(
            seq=data["seq"],
            offset=data["offset"],
            bids=data["bids"],
            asks=data["asks"],
        )

    def restore_into(self, book: OrderBook) -> None:
        """빈 book에 스냅샷 상태를 복원한다."""
        for data in self.bids:
            book.add(OrderCodec.from_dict(data))
        for data in self.asks:
            book.add(OrderCodec.from_dict(data))
        book.drain_dirty_levels()  # 복원 add로 쌓인 dirty 제거
        book.seq = self.seq


__all__ = ["SnapshotMsg"]
