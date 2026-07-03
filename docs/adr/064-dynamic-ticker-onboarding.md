# ADR-064: 동적 티커 온보딩 (컨트롤 토픽 기반 런타임 상장)

## Status
Accepted (2026-06-22). Phase A~D 구현 완료 (add-only MVP). 런타임 e2e 미검증 — 단위/빌드만 통과.

## Context
티커 라이프사이클은 "신규 상장 = DB 트랜잭션 한 번"(ADR-011)으로 기획됐으나, 실제로는 새 심볼이
거래되려면 재시작/재배포가 필요했다. 무엇이 이미 동적이고 무엇이 막혔는지:

- **이미 동적**: status 전환은 주문 게이트(`assertTradable`)가 DB를 라이브로 읽어 즉시 효력.
  BE produce 파티션도 `Ticker.partition`을 DB에서 lazy로 읽음.
- **부팅 고정(blocker)**: ① 매칭엔진 레인은 JSON config(ADR-013)에서 부팅 1회 로드 — reload 없음,
  config에 없는 심볼은 `no lane`으로 드롭. ② 그 config가 Docker 이미지에 baked(볼륨 없음) → 변경 시
  이미지 재빌드+재배포. ③ BE `TickerStatsService.meta`가 부팅 1회 로드 — refresh 없음 → 신규 심볼이
  exchange-info/tickers/FE에 안 보임.
- **별도 버그(Phase A로 수정)**: 런타임 create가 `partition = max+1`을 써서 ADR-063의
  `FNV-1a(symbol)%P` 고정 버킷 불변식(config==DB==produce)을 깼다.

**핵심 통찰**: ADR-063의 고정 P 버킷에서 엔진은 부팅 시 **P개 파티션을 전부 assign**한다. 따라서 새 심볼은
**이미 소비 중인 버킷**에 들어가고, 신규 상장에 Kafka 파티션 재배정·오프셋 재조정이 **불필요**하다.
엔진이 할 일은 레지스트리에 **레인 1개 in-memory insert**뿐이며, 신규 심볼은 빈 책에서 시작(ADR-034)하므로
복구할 스냅샷도 없다. 이로써 동적 온보딩은 "엔진 레인 + BE 메타를 런타임에 살리는 것"으로 환원된다.

## Decision
1. **파티션 = `FNV-1a(symbol) % P` (Phase A, 완료).** `max+1`/Kafka 파티션 grow 폐기. BE `partitionForSymbol`,
   CLI 동일 구현. `dto.partition`을 주면 FNV%P와 다를 때 거부. 불변식 config==DB==produce가 결정적으로 성립.
   전제: BE `MATCH_*_PARTITIONS` == infra 동일.

2. **컨트롤 토픽 도입.** `match.{spot,futures}.control` — log-compacted, **1 partition**, key=symbol,
   value `{op:"ADD", market, symbol, baseAsset, quoteAsset, partition, pricePrecision, qtyPrecision, minNotional}`
   (엔진은 partition/precision, BE는 meta 필드 사용). JSON config(ADR-013)는 **부팅 시드로 유지**하고, 컨트롤
   토픽이 **런타임 추가분의 영속 소스** — 컴팩션 replay로 재시작 후에도 config에 없는 추가분이 보존된다.

3. **엔진 동적 레인 (구현).** 부팅 = config 시드 위에 컨트롤 토픽 전량 흡수(market별, 토픽 없으면 skip).
   런타임 = 메인 루프에서 `ADD` 수신 시 `build_lane` 후 `registry.add`(파티션 재배정 없음, 빈 책). 컨트롤
   파티션은 `restore`의 단일 assign에 묶어 라이브 유지(ctrl_hw부터). 빈 버킷 edge만 재시작 필요(경고 로그).
   `gc.freeze`는 신규 레인에 영향 없음(새 객체는 GC 추적 유지). **add-only** — 런타임 `remove`는 후속.

4. **createTicker 전파 (구현).** DB 커밋 후 `match.{market}.control`에 ADD produce(SPOT/FUTURES만). 엔진은
   레인을, 각 Nest 앱은 `TickerStatsService.upsertMetaFromControl`로 meta를 갱신 → 재시작 없이 거래/노출.
   produce 실패 시 `propagated:false` + 재시작 fallback 안내. portal에 KafkaModule(producer) 추가.

5. **status 전환은 무변경.** 기존대로 라이브 거래 게이트(`assertTradable`).

## Rationale
- 고정 P 버킷이 레인 추가를 메모리 insert로 환원 → 엔진 동적화가 tractable.
- BE↔엔진은 Kafka로만 통신(ADR-010). 컨트롤 토픽은 그 결을 따르며, 컴팩션이 baked config를 대체하는
  영속 레지스트리가 되어 재배포 의존을 제거한다.
- 이벤트 구동 전파가 "신규 상장 = 트랜잭션 한 번"(ADR-011)의 원래 의도를 실제로 달성한다.

## Consequences
- `kafka-init`에 컨트롤 토픽 2개 추가(compact, 1 partition).
- JSON config(ADR-013)는 본 ADR로 대체. 초기 seed로만 남기거나(seed가 컨트롤 토픽에 1회 발행) 제거.
  Lane 패턴·1인스턴스 N ticker는 유지. 본 ADR은 ADR-063 위에 빌드.
- 엔진 메인 루프가 `msg.topic()` 분기 필요(컨트롤 vs 주문).
- BE/infra의 P 동일 유지가 전제(Phase A).
- **범위 밖**: HA / 컨슈머그룹 `subscribe()` 전환은 별도 트랙(단일 박스 단일 장애점 한계는 유지).
  런타임 디리스팅(`remove`)·리버킷 시 BE 파티션 캐시 무효화도 후속.
