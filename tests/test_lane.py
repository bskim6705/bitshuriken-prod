"""LaneRegistry config 로드/lookup + 런타임 add/markets."""

import json

from engine.lane import LaneRegistry, build_lane


def test_load_lanes_and_lookup(tmp_path):
    def ticker(market, symbol, partition, price_p, qty_p):
        return {
            "market": market,
            "symbol": symbol,
            "partition": partition,
            "pricePrecision": price_p,
            "qtyPrecision": qty_p,
        }

    # 같은 partition 버킷(0)을 두 ticker가 공유 — 라우팅은 symbol 기준
    config = {
        "tickers": [
            ticker("spot", "BTCUSDT", 0, 2, 5),
            ticker("spot", "ETHUSDT", 0, 2, 3),
        ]
    }
    path = tmp_path / "tickers.json"
    path.write_text(json.dumps(config))

    registry = LaneRegistry.load(str(path))

    assert len(registry) == 2
    assert registry.symbols() == ["BTCUSDT", "ETHUSDT"]  # config 순서 유지

    lane = registry.get("BTCUSDT")
    assert lane is not None
    assert (lane.topic_out, lane.topic_book, lane.topic_state) == (
        "match.spot.out",
        "match.spot.book",
        "match.spot.state",
    )
    assert lane.partition == 0
    assert lane.book.symbol == "BTCUSDT"
    assert lane.book.qty_step == 10**3  # 10^(8-5)
    assert lane.book.price_tick == 10**6  # 10^(8-2)
    assert lane.last_offset == -1 and lane.dirty is False

    # 같은 버킷의 다른 symbol도 독립 lane
    assert registry.get("ETHUSDT").book.qty_step == 10**5  # 10^(8-3)
    assert registry.get("UNKNOWN") is None
    assert registry.get(None) is None


def test_registry_add_live_and_markets():
    # 부팅 시드 없이 직접 구성 — spot/futures 혼재
    registry = LaneRegistry(
        [
            build_lane("spot", "BTCUSDT", 0, 2, 5),
            build_lane("futures", "ETHUSDT", 2, 2, 3),
        ]
    )
    assert registry.markets() == ["spot", "futures"]  # 정의 순서, 중복 제거

    lanes = registry.all()  # main의 lanes 참조와 동일 객체여야 함
    added = registry.add(build_lane("spot", "NEWUSDT", 3, 2, 4))
    assert added is True
    assert registry.get("NEWUSDT").partition == 3
    assert registry.get("NEWUSDT").topic_in == "match.spot.in"
    assert lanes is registry.all() and len(lanes) == 3  # append가 같은 리스트에 반영

    # 중복은 무시(False) — 멱등
    assert registry.add(build_lane("spot", "NEWUSDT", 3, 2, 4)) is False
    assert len(registry) == 3
