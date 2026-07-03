"""매칭 결과 outbound 발행 — trade / order update / depth diff."""

from engine.lane import Lane
from engine.matcher import now_ms
from engine.order import Order
from engine.trade import Trade
from messaging.producer import KafkaProducerWrapper
from schemas.messages import DepthDiffMsg, OrderUpdateMsg, TradeMsg


class OutboundPublisher:
    def __init__(self, producer: KafkaProducerWrapper) -> None:
        self.producer = producer

    def publish_trades(self, lane: Lane, trades: list[Trade]) -> None:
        sym = lane.book.symbol
        for trade in trades:
            self.producer.emit(
                lane.topic_out, lane.partition, TradeMsg.from_trade(trade).to_dict(), key=sym
            )

    def publish_orders(self, lane: Lane, orders: list[Order]) -> None:
        ts = now_ms()
        sym = lane.book.symbol
        for order in orders:
            self.producer.emit(
                lane.topic_out,
                lane.partition,
                OrderUpdateMsg.from_order(order, ts).to_dict(),
                key=sym,
            )

    def publish_book_diff(self, lane: Lane) -> None:
        """매 inbound 처리 직후 호출. 변경된 level 들을 한 diff message로 emit."""
        dirty = lane.book.drain_dirty_levels()
        if not dirty:
            return
        msg = DepthDiffMsg.from_dirty(lane.book.symbol, dirty, lane.book.seq, now_ms())
        self.producer.emit(lane.topic_book, lane.partition, msg.to_dict(), key=lane.book.symbol)
