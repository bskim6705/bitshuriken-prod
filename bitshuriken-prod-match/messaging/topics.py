"""Kafka 토픽 이름과 op 코드 상수."""

# Op codes
OP_NEW_ORDER = "NO"
OP_CANCEL_ORDER = "CO"
OP_TRADE = "TR"
OP_ORDER_UPDATE = "OU"
OP_DEPTH_DIFF = "DPD"

# Control topic ops (런타임 ticker 상장)
OP_ADD_TICKER = "ADD"
CONTROL_PARTITION = 0  # control 토픽은 1 partition (compacted, key=symbol)

# Market slugs (Prisma MarketType의 lowercase)
MARKET_SPOT = "spot"
MARKET_FUTURES = "futures"


def inbound_topic(market: str) -> str:
    return f"match.{market}.in"


def outbound_topic(market: str) -> str:
    return f"match.{market}.out"


def book_topic(market: str) -> str:
    """Orderbook diff stream용 별도 topic."""
    return f"match.{market}.book"


def state_topic(market: str) -> str:
    """Lane 스냅샷용 log-compacted topic. key=symbol."""
    return f"match.{market}.state"


def control_topic(market: str) -> str:
    """Ticker 라이프사이클 컨트롤용 log-compacted topic. key=symbol, 1 partition."""
    return f"match.{market}.control"
