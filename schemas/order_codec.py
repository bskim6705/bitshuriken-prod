"""Order 전 필드 ↔ dict 직렬화. 축약 키 + int는 string (JSON safe int)."""

from engine.order import Order, OrderSide, OrderStatus, OrderType, TimeInForce


class OrderCodec:
    @staticmethod
    def to_dict(order: Order) -> dict:
        return {
            "id": order.id,
            "u": order.user_id,
            "s": order.symbol,
            "t": order.type.value,
            "sd": order.side.value,
            "tif": order.time_in_force.value,
            "p": str(order.price),
            "oq": str(order.orig_qty),
            "oqq": str(order.orig_quote_qty),
            "eq": str(order.executed_qty),
            "cqq": str(order.cumulative_quote_qty),
            "st": order.status.value,
            "ts": order.ts,
        }

    @staticmethod
    def from_dict(data: dict) -> Order:
        return Order(
            id=data["id"],
            user_id=data["u"],
            symbol=data["s"],
            type=OrderType(data["t"]),
            side=OrderSide(data["sd"]),
            time_in_force=TimeInForce(data["tif"]),
            price=int(data["p"]),
            orig_qty=int(data["oq"]),
            orig_quote_qty=int(data["oqq"]),
            executed_qty=int(data["eq"]),
            cumulative_quote_qty=int(data["cqq"]),
            status=OrderStatus(data["st"]),
            ts=data["ts"],
        )


__all__ = ["OrderCodec"]
