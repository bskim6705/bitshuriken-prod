from dataclasses import dataclass, field
from enum import Enum


class OrderType(str, Enum):
    LIMIT = "L"
    MARKET = "M"
    POST_ONLY = "PO"


class OrderSide(str, Enum):
    BUY = "B"
    SELL = "S"


class OrderStatus(str, Enum):
    NEW = "N"
    OPEN = "O"
    PARTIAL = "P"
    FILLED = "F"
    CANCELED = "C"
    REJECTED = "R"
    EXPIRED = "E"


class TimeInForce(str, Enum):
    GTC = "G"
    IOC = "I"
    FOK = "F"


@dataclass(slots=True)
class Order:
    id: str
    user_id: str
    symbol: str
    type: OrderType
    side: OrderSide
    time_in_force: TimeInForce
    price: int  # * 10 ** 8, 0 for MARKET
    orig_qty: int  # base, 0 if quote-driven
    orig_quote_qty: int  # quote, 0 if base-driven
    executed_qty: int = 0
    cumulative_quote_qty: int = 0
    status: OrderStatus = OrderStatus.OPEN
    ts: int = field(default=0)

    @property
    def is_quote_driven(self) -> bool:
        # MARKET BUY 중 quote 예산이 있는 주문만 quote-driven (spot).
        # futures MARKET BUY는 oqq=0으로 base-driven — MARKET SELL과 같은 경로.
        return (
            self.type == OrderType.MARKET
            and self.side == OrderSide.BUY
            and self.orig_quote_qty > 0
        )

    @property
    def remaining_qty(self) -> int:
        return self.orig_qty - self.executed_qty

    @property
    def remaining_quote_qty(self) -> int:
        return self.orig_quote_qty - self.cumulative_quote_qty
