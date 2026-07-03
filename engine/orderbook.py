from collections import OrderedDict
from typing import Iterable, Optional

from sortedcontainers import SortedDict

from .order import Order, OrderSide


class OrderBook:
    """단일 ticker의 가격-시간 우선 호가창.

    1 partition = 1 ticker이므로 market 정보는 보유하지 않는다.
    """

    def __init__(
        self,
        symbol: str,
        partition: int,
        qty_step: int,
        price_tick: int,
    ):
        self.symbol = symbol
        self.partition = partition
        # qty_step / price_tick은 int * 10^8 단위. 예: qtyPrecision=5 -> qty_step=10^3
        self.qty_step = qty_step
        self.price_tick = price_tick
        self.seq: int = 0  # 모든 변경마다 +1, L2 delta publish 시 사용

        # price (int) -> OrderedDict[order_id, Order]
        self._bids: SortedDict[int, OrderedDict[str, Order]] = SortedDict()
        self._asks: SortedDict[int, OrderedDict[str, Order]] = SortedDict()

        # order_id -> (side, price), cancel을 O(log n)으로 만들기 위한 인덱스
        self._index: dict[str, tuple[OrderSide, int]] = {}

        # 마지막 drain 이후 변경된 (side, price). depth diff publish용.
        self._dirty: set[tuple[OrderSide, int]] = set()

    # ---------- read ----------

    def contains(self, order_id: str) -> bool:
        """호가창에 resting 중인 주문인지. 중복 NEW 멱등 처리에 사용."""
        return order_id in self._index

    def best_bid_price(self) -> Optional[int]:
        if not self._bids:
            return None
        return self._bids.peekitem(-1)[0]

    def best_ask_price(self) -> Optional[int]:
        if not self._asks:
            return None
        return self._asks.peekitem(0)[0]

    def get_bid_levels(self) -> Iterable[tuple[int, OrderedDict[str, Order]]]:
        """가격 내림차순 (best bid 먼저)."""
        return reversed(self._bids.items())

    def get_ask_levels(self) -> Iterable[tuple[int, OrderedDict[str, Order]]]:
        """가격 오름차순 (best ask 먼저)."""
        return self._asks.items()

    # ---------- write ----------

    def add(self, order: Order) -> Order:
        """주문을 호가창에 삽입. 같은 가격대 안에서는 FIFO."""
        if order.id in self._index:
            raise ValueError(f"duplicate order id: {order.id}")

        book_side = self._bids if order.side == OrderSide.BUY else self._asks
        level = book_side.get(order.price)
        if level is None:
            level = OrderedDict()
            book_side[order.price] = level

        level[order.id] = order
        self._index[order.id] = (order.side, order.price)
        self.seq += 1
        self._dirty.add((order.side, order.price))
        return order

    def cancel(self, order_id: str) -> Optional[Order]:
        """주문을 호가창에서 제거하고 반환. 없으면 None."""
        meta = self._index.pop(order_id, None)
        if meta is None:
            return None

        side, price = meta
        book_side = self._bids if side == OrderSide.BUY else self._asks
        level = book_side[price]
        order = level.pop(order_id)

        if not level:
            del book_side[price]

        self.seq += 1
        self._dirty.add((side, price))
        return order

    def partial_fill(self, order: Order, fill_qty: int) -> Order:
        """부분 체결: executed_qty를 증가시킨다. 완전 체결은 cancel()을 사용."""
        if fill_qty <= 0 or fill_qty >= order.remaining_qty:
            raise ValueError("fill_qty must be > 0 and < remaining_qty")
        order.executed_qty += fill_qty
        self.seq += 1
        self._dirty.add((order.side, order.price))
        return order

    # ---------- depth diff publishing ----------

    def drain_dirty_levels(self) -> list[tuple[OrderSide, int, int]]:
        """변경된 level의 현재 합산 qty를 반환하고 clear. 사라진 level은 qty=0."""
        result: list[tuple[OrderSide, int, int]] = []
        for side, price in self._dirty:
            book_side = self._bids if side == OrderSide.BUY else self._asks
            level = book_side.get(price)
            qty = sum(o.remaining_qty for o in level.values()) if level else 0
            result.append((side, price, qty))
        self._dirty.clear()
        return result
