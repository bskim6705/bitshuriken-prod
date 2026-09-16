# bitshuriken-prod-match

Bitshuriken 매칭엔진 — Python. Kafka로 BE와 통신하는 시장-무관(market-agnostic) 체결 엔진. (시스템 개요·서비스 간 계약은 상위 `../CLAUDE.md`.)

## 구조
- `engine/` — lane, matcher, order, orderbook, trade. 1 인스턴스 N ticker (Lane 패턴, ADR-013).
- `messaging/` — Kafka consumer/producer, topics, snapshot_store.
- `schemas/` — 메시지 스키마.
- `config/` — `tickers-spot.json`, `tickers-futures.json`(엔진 실행용), `tickers.json`(합본 — BE prisma seed의 티커 소스. 엔진 실행에는 쓰지 않는다). 엔진은 config에서 lane을 생성(마켓은 env `MATCH_CONFIG_PATH`로 선택).
- `main.py` — 부팅: 스냅샷 복원 → WAL replay → control 토픽 흡수 → 라이브 소비.

## 정밀도 (엄격)
- 엔진 내부는 **int (`* 10^8`)**. 항상 floor, 부동소수점 금지.
- Kafka 메시지는 scaled-int **string**(JSON safe int). 변환: 메시지 string ↔ 엔진 int.
- stepSize = `10^(8 - qtyPrecision)` int를 OrderBook이 보유(quote-driven MARKET의 수량 floor). tickSize는 엔진이 검증하지 않는다 — 입력 검증은 BE. (전체 표는 `../CLAUDE.md`.)

## Kafka 계약
- 토픽 `match.{spot|futures}.{in|out|book|state|control}`. 메시지 본문 `op` 필드로 종류 구분 (NO/CO/TR/OU/DPD, control은 ADD).
- 파티션 = FNV-1a(symbol) % P. P는 BE·infra와 동일해야 한다 (ADR-063). `state`/`control`은 log-compacted (key=symbol), control은 1 partition.
- 상태 복구: dirty lane 30s마다 `state` 토픽 스냅샷 → 부팅 시 복원 후 inbound WAL replay (ADR-034). consumer는 auto-commit off, 스냅샷 offset부터 수동 assign. 재emit은 BE가 `sourceKey` unique로 멱등 처리.

## Run / test
```bash
python -m venv venv && source venv/bin/activate && pip install -r requirements.txt
# 합본 config(tickers.json)로 spot+futures를 한 프로세스에 띄우는 모드는 프로드 미사용이며 잠재 버그가 있다(관찰 #31) — 아래 분리 운영만 쓴다
MATCH_CONFIG_PATH=config/tickers-spot.json python main.py    # 분리 운영(spot)
MATCH_CONFIG_PATH=config/tickers-futures.json python main.py # 분리 운영(futures)
python -m pytest -q                               # tests/
```
전제: docker의 kafka 실행 + 토픽 생성(`../scripts/create-kafka-topics.sh`). 새 티커 상장은 control 토픽 런타임(ADR-064) 또는 config 시드. ADR/피드백은 상위 `../docs/`.
