"""FOK 거부 경로 공용 단정 — 체결 0 · taker만 통지 · REJECTED · 책 무변경(seq 포함) · rest 없음."""

from engine.matcher import MatchResult
from engine.order import Order, OrderStatus
from engine.orderbook import OrderBook
from scenario_support import book_state


def assert_fok_rejected(book: OrderBook, before: tuple, result: MatchResult, taker: Order) -> None:
    assert result.trades == []
    assert result.updated_orders == [taker]
    assert taker.status == OrderStatus.REJECTED
    assert taker.executed_qty == 0
    assert book_state(book) == before  # 부분 체결도, rest도 없음 — seq까지 동일
    assert not book.contains(taker.id)
