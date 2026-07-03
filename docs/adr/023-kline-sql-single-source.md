# ADR-023: Kline은 Trade 테이블 SQL 단일 소스 (in-memory 캔들 없음)

## Status
Accepted

## Context

차트용 kline(캔들)이 필요하다 — REST 히스토리 + WS 라이브 스트림.

- ADR-020은 derived market data를 Order 테이블 조회로 만들지 말라고 했다 (정산 worker latency). 그러나 **Trade row는 TR 핸들러가 hot-path에서 동기 INSERT**하므로 stale하지 않다 — kline의 적법한 소스다.
- in-memory 현재 캔들 + SQL 히스토리 이원화는 초기화 레이스(SQL await 중 도착하는 trade의 이중 집계)와 정합성 검증 부담을 만든다 (설계 리뷰에서 확인).
- 같은 ms에 여러 체결이 흔하다 (한 sweep의 TR들이 같은 ts 공유) — createdAt만으로 open/close 결정 불가.

## Decision

**kline은 Trade 테이블 SQL 집계 단일 소스로 만든다. in-memory 캔들 상태를 두지 않는다.**

1. `Trade.seq`(autoincrement, 파티션 내 엔진 발행 순서)로 버킷 내 open/close tie-break. `Trade.executedAt`(엔진 ts)으로 버킷팅 — createdAt(컨슈머 도착 시각)이 아니라 진짜 체결 시각.
2. REST `GET /spot/market/klines`: 윈도 `[endTime - limit*w, endTime)` 산술 고정, anchor 쿼리 1회로 빈 버킷 fill-forward (O=H=L=C=직전 close, V=0), 심볼 최초 체결 이전은 trim, 현재 미완결 버킷 포함.
3. WS `<sym>@kline_<interval>`: 게이트웨이 1s 타이머가 구독 중인 (sym,interval)만 현재 버킷을 SQL 재계산해 push. 롤오버 시 직전 버킷 `isFinal:true` 1회 push. Binance의 1–2s kline push 주기와 동급.
4. 인터벌: `1m…1M` 15종, `domain/kline/intervals.ts` 단일 상수 (exchange-info가 같은 소스 노출 — FE 하드코딩 금지, feedback-015).
5. REST/WS 동일한 named-object shape (positional array 안 씀 — FE 디코더 1개).
6. `seq`는 API 응답에 노출 금지 (내부 정렬용).

## Rationale

- 소스 1개 = 정합성 버그 클래스 제거. 1s 주기 × 구독된 스트림 수만큼의 인덱스드 쿼리는 dev 플랫폼 규모에서 충분히 싸다.
- 빈 캔들 fill-forward를 BE에서 하면 FE 차트가 단순해진다.

## Consequences

- kline 레이턴시 최대 ~1s (trade 단위 push 아님) — Binance 실서비스와 동급이라 수용.
- 거래량이 커지면 (sym,interval)별 materialized 캔들 테이블로 이행 필요 — 그때 이 ADR 갱신.
- 24h ticker(in-memory TickerStatsService)와 kline(SQL)은 소스가 다르지만 둘 다 Trade 스트림 파생이라 의미적으로 일치.
