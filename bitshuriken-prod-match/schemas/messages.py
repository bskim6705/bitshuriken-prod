"""Kafka 메시지 직렬화/역직렬화.

축약 필드명 + string 직렬화 + 'op' 코드로 종류 식별.
Market은 토픽 이름이 알고 있으므로 메시지 본문에 없음.
"""

from dataclasses import dataclass
from typing import Iterable

from engine.order import Order, OrderSide, OrderType, TimeInForce
from engine.trade import Trade
from messaging.topics import (
    OP_CANCEL_ORDER,
    OP_DEPTH_DIFF,
    OP_NEW_ORDER,
    OP_ORDER_UPDATE,
    OP_TRADE,
)


@dataclass(slots=True)
class NewOrderMsg:
    """Inbound: 신규 주문."""

    op: str  # "NO"
    id: str
    u: str  # user_id
    s: str  # symbol
    t: str  # type
    sd: str  # side
    tif: str  # time in force
    p: str  # price (int * 10^8 as string), MARKET이면 "0"
    oq: str  # origQty (base, int * 10^8), quote-driven이면 "0"
    oqq: str  # origQuoteQty (quote, int * 10^8), base-driven이면 "0"

    def to_order(self) -> Order:
        return Order(
            id=self.id,
            user_id=self.u,
            symbol=self.s,
            type=OrderType(self.t),
            side=OrderSide(self.sd),
            time_in_force=TimeInForce(self.tif),
            price=int(self.p),
            orig_qty=int(self.oq),
            orig_quote_qty=int(self.oqq),
        )

    @classmethod
    def from_dict(cls, data: dict) -> "NewOrderMsg":
        return cls(
            op=data["op"],
            id=data["id"],
            u=data["u"],
            s=data["s"],
            t=data["t"],
            sd=data["sd"],
            tif=data["tif"],
            p=data.get("p", "0"),
            oq=data.get("oq", "0"),
            oqq=data.get("oqq", "0"),
        )


@dataclass(slots=True)
class CancelOrderMsg:
    """Inbound: 주문 취소."""

    op: str  # "CO"
    id: str  # order id
    u: str  # user_id
    s: str  # symbol

    @classmethod
    def from_dict(cls, data: dict) -> "CancelOrderMsg":
        return cls(op=data["op"], id=data["id"], u=data["u"], s=data["s"])


@dataclass(slots=True)
class TradeMsg:
    """Outbound: 체결 발생."""

    op: str  # "TR"
    tid: str  # trade id
    s: str  # symbol
    mo: str  # maker order id
    to: str  # taker order id
    mu: str  # maker user id
    tu: str  # taker user id
    sd: str  # taker side
    p: str  # price (int * 10^8)
    q: str  # qty (int * 10^8)
    ts: int  # epoch ms

    def to_dict(self) -> dict:
        return {
            "op": self.op,
            "tid": self.tid,
            "s": self.s,
            "mo": self.mo,
            "to": self.to,
            "mu": self.mu,
            "tu": self.tu,
            "sd": self.sd,
            "p": self.p,
            "q": self.q,
            "ts": self.ts,
        }

    @classmethod
    def from_trade(cls, trade: Trade) -> "TradeMsg":
        return cls(
            op=OP_TRADE,
            tid=trade.id,
            s=trade.symbol,
            mo=trade.maker_order_id,
            to=trade.taker_order_id,
            mu=trade.maker_user_id,
            tu=trade.taker_user_id,
            sd=trade.taker_side.value,
            p=str(trade.price),
            q=str(trade.qty),
            ts=trade.ts,
        )


@dataclass(slots=True)
class OrderUpdateMsg:
    """Outbound: 주문 상태 변경."""

    op: str  # "OU"
    id: str
    u: str
    st: str  # status
    eq: str  # executed_qty
    cqq: str  # cumulative_quote_qty
    ts: int

    def to_dict(self) -> dict:
        return {
            "op": self.op,
            "id": self.id,
            "u": self.u,
            "st": self.st,
            "eq": self.eq,
            "cqq": self.cqq,
            "ts": self.ts,
        }

    @classmethod
    def from_order(cls, order: Order, ts: int) -> "OrderUpdateMsg":
        return cls(
            op=OP_ORDER_UPDATE,
            id=order.id,
            u=order.user_id,
            st=order.status.value,
            eq=str(order.executed_qty),
            cqq=str(order.cumulative_quote_qty),
            ts=ts,
        )


@dataclass(slots=True)
class DepthDiffMsg:
    """Outbound: orderbook level delta. qty="0"은 level 제거 신호."""

    op: str  # "DPD"
    s: str  # symbol
    ts: int  # epoch ms
    u: int  # OrderBook.seq (이 batch 적용 후)
    b: list[list[str]]  # bids: [[priceIntStr, qtyIntStr], ...]
    a: list[list[str]]  # asks

    def to_dict(self) -> dict:
        return {"op": self.op, "s": self.s, "ts": self.ts, "u": self.u, "b": self.b, "a": self.a}

    @classmethod
    def from_dirty(
        cls,
        symbol: str,
        dirty: Iterable[tuple[OrderSide, int, int]],
        seq: int,
        ts: int,
    ) -> "DepthDiffMsg":
        bids: list[list[str]] = []
        asks: list[list[str]] = []
        for side, price, qty in dirty:
            level = [str(price), str(qty)]
            if side == OrderSide.BUY:
                bids.append(level)
            else:
                asks.append(level)
        return cls(op=OP_DEPTH_DIFF, s=symbol, ts=ts, u=seq, b=bids, a=asks)


def op_of(payload: dict) -> str:
    return payload.get("op", "")


__all__ = [
    "NewOrderMsg",
    "CancelOrderMsg",
    "TradeMsg",
    "OrderUpdateMsg",
    "DepthDiffMsg",
    "op_of",
    "OP_NEW_ORDER",
    "OP_CANCEL_ORDER",
    "OP_TRADE",
    "OP_ORDER_UPDATE",
    "OP_DEPTH_DIFF",
]
