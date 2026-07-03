import time
from dataclasses import dataclass
from typing import Optional

from .order import Order, OrderSide, OrderStatus, OrderType, TimeInForce
from .orderbook import OrderBook
from .trade import Trade

SCALE = 10**8


@dataclass(slots=True)
class MatchResult:
    """submit_new_order의 결과. 발생한 trade 목록과 상태가 변한 order 목록."""

    trades: list[Trade]
    updated_orders: list[Order]


def now_ms() -> int:
    return time.time_ns() // 1_000_000


class MatchEngine:
    """OrderBook에 대한 매칭 알고리즘만 책임진다.

    OrderBook 자체의 라우팅/저장은 main loop가 담당. engine은 OrderBook을 인자로 받아
    매칭 작업만 수행.
    """

    def submit_new_order(self, book: OrderBook, taker: Order) -> MatchResult:
        trades: list[Trade] = []
        updated: list[Order] = []

        # 0. 멱등성 — 이미 resting 중인 id의 중복 NEW는 무시(at-least-once 재전송 대비).
        #    복구 시 BE가 NO를 재드라이브해도 이중 매칭/중복 add를 막는다.
        if book.contains(taker.id):
            return MatchResult(trades, updated)

        # 1. POST_ONLY 사전 체크
        if taker.type == OrderType.POST_ONLY and self._would_cross(book, taker):
            taker.status = OrderStatus.REJECTED
            updated.append(taker)
            return MatchResult(trades, updated)

        # 2. FOK 사전 체크
        if taker.time_in_force == TimeInForce.FOK and not self._has_full_liquidity(
            book, taker
        ):
            taker.status = OrderStatus.REJECTED
            updated.append(taker)
            return MatchResult(trades, updated)

        # 3. 매칭 루프
        self._match(book, taker, trades, updated)

        # 4. 잔여 처리
        if self._is_done(taker):
            taker.status = OrderStatus.FILLED
            updated.append(taker)
            return MatchResult(trades, updated)

        tif = taker.time_in_force
        if taker.type == OrderType.MARKET or tif == TimeInForce.IOC:
            has_filled = taker.executed_qty > 0
            taker.status = OrderStatus.PARTIAL if has_filled else OrderStatus.CANCELED
            updated.append(taker)
        else:
            # LIMIT/POST_ONLY + GTC: 호가창에 rest
            taker.status = OrderStatus.PARTIAL if taker.executed_qty > 0 else OrderStatus.OPEN
            book.add(taker)
            updated.append(taker)

        return MatchResult(trades, updated)

    def submit_cancel_order(self, book: OrderBook, order_id: str) -> Optional[Order]:
        order = book.cancel(order_id)
        if order is not None:
            order.status = OrderStatus.CANCELED
        return order

    # ---------- helpers ----------

    def _is_done(self, taker: Order) -> bool:
        if taker.is_quote_driven:
            return taker.remaining_quote_qty <= 0
        return taker.remaining_qty <= 0

    def _would_cross(self, book: OrderBook, taker: Order) -> bool:
        if taker.side == OrderSide.BUY:
            best = book.best_ask_price()
            return best is not None and taker.price >= best
        best = book.best_bid_price()
        return best is not None and taker.price <= best

    def _has_full_liquidity(self, book: OrderBook, taker: Order) -> bool:
        levels = (
            book.get_ask_levels() if taker.side == OrderSide.BUY else book.get_bid_levels()
        )
        if taker.is_quote_driven:
            target_quote = taker.orig_quote_qty
            available_quote = 0
            for price, level in levels:
                for maker in level.values():
                    available_quote += maker.remaining_qty * price // SCALE
                    if available_quote >= target_quote:
                        return True
            return available_quote >= target_quote

        target_qty = taker.orig_qty
        available_qty = 0
        for price, level in levels:
            if taker.type in (OrderType.LIMIT, OrderType.POST_ONLY):
                if taker.side == OrderSide.BUY and price > taker.price:
                    break
                if taker.side == OrderSide.SELL and price < taker.price:
                    break
            for maker in level.values():
                available_qty += maker.remaining_qty
                if available_qty >= target_qty:
                    return True
        return available_qty >= target_qty

    def _match(
        self,
        book: OrderBook,
        taker: Order,
        trades: list[Trade],
        updated: list[Order],
    ) -> None:
        while not self._is_done(taker):
            maker = self._peek_best_maker(book, taker)
            if maker is None:
                return

            fill_qty = self._compute_fill_qty(taker, maker, book.qty_step)
            if fill_qty <= 0:
                return  # quote-driven에서 stepSize 1단위도 못 사는 경우

            trade_price = maker.price
            ts = now_ms()

            # tid = makerOrderId-takerOrderId. 한 taker는 각 maker를 최대 1회 체결하므로
            # 이 쌍이 체결의 고유키이고, 입력만으로 결정되어 재부팅/리플레이에도 동일하다.
            # → 엔진이 같은 체결을 재발행해도 BE의 sourceKey 멱등이 중복 정산을 차단한다.
            trades.append(
                Trade(
                    id=f"{maker.id}-{taker.id}",
                    symbol=book.symbol,
                    maker_order_id=maker.id,
                    taker_order_id=taker.id,
                    maker_user_id=maker.user_id,
                    taker_user_id=taker.user_id,
                    taker_side=taker.side,
                    price=trade_price,
                    qty=fill_qty,
                    ts=ts,
                )
            )

            taker.executed_qty += fill_qty
            taker.cumulative_quote_qty += fill_qty * trade_price // SCALE
            # maker도 동일 누적 — OU의 eq/cqq가 이 값으로 직렬화된다 (BE 환불 계산이 의존).
            # eq는 remaining_qty 판정에 영향을 주므로 분기 안에서 증가시킨다.
            maker.cumulative_quote_qty += fill_qty * trade_price // SCALE

            if fill_qty == maker.remaining_qty:
                book.cancel(maker.id)
                maker.executed_qty += fill_qty
                maker.status = OrderStatus.FILLED
                updated.append(maker)
            else:
                book.partial_fill(maker, fill_qty)  # executed_qty 증가 포함
                maker.status = OrderStatus.PARTIAL
                updated.append(maker)

    def _compute_fill_qty(self, taker: Order, maker: Order, qty_step: int) -> int:
        if taker.is_quote_driven:
            remaining_quote = taker.remaining_quote_qty
            max_base_by_quote = remaining_quote * SCALE // maker.price
            # stepSize로 내림 (dust 발생)
            max_base_by_quote = (max_base_by_quote // qty_step) * qty_step
            return min(maker.remaining_qty, max_base_by_quote)
        return min(maker.remaining_qty, taker.remaining_qty)

    def _peek_best_maker(self, book: OrderBook, taker: Order) -> Optional[Order]:
        """taker가 매칭할 수 있는 best maker를 반환. 없으면 None."""
        if taker.side == OrderSide.BUY:
            best_price = book.best_ask_price()
            if best_price is None:
                return None
            if taker.type in (OrderType.LIMIT, OrderType.POST_ONLY) and best_price > taker.price:
                return None
            level = book._asks[best_price]
        else:
            best_price = book.best_bid_price()
            if best_price is None:
                return None
            if taker.type in (OrderType.LIMIT, OrderType.POST_ONLY) and best_price < taker.price:
                return None
            level = book._bids[best_price]

        first_id = next(iter(level))
        return level[first_id]
