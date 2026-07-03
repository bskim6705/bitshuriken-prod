from dataclasses import dataclass

from .order import OrderSide


@dataclass(slots=True)
class Trade:
    id: str
    symbol: str
    maker_order_id: str
    taker_order_id: str
    maker_user_id: str
    taker_user_id: str
    taker_side: OrderSide
    price: int  # * 10 ** 8
    qty: int  # * 10 ** 8
    ts: int  # epoch ms
