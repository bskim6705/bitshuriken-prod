# ADR-040: WS 마켓 스트림 완성 + 페이로드 충실도 정책

## Status
Accepted (2026-06-14)

## Context
WS 마켓 표면 감사 결과 두 가지가 드러났다.
1. **futures 마켓 WS(`/ws/fmarket`)가 spot 대비 크게 뒤처짐** — depth/trade/ticker/!ticker@arr/markPrice 5종뿐. `@kline`이 없어 FE가 `GET /futures/market/klines`를 5s 폴링(ADR-033 §5에서 의도적으로 제외했던 결정), `@bookTicker`·`@miniTicker`·`@aggTrade`·`!markPrice@arr` 부재.
2. spot에도 `@aggTrade` WS가 없음(REST `agg-trades`만).

또한 "binance like"를 어디까지 가져갈지 — 페이로드를 Binance 단일문자 키(e/E/s/p/q…)+array klines/depth로 **byte-for-byte** 맞출지 — 가 결정 사항이었다. 현재 API는 의미 있는 named 필드(`open24h`, named kline object)를 쓰고 **FE(`BaseWsClient` 파생)가 이 shape에 의존**한다.

## Decision

### 1. 페이로드 충실도 — Binance 스타일 docs, named 페이로드 유지
WS/REST 페이로드를 Binance 단일문자 키로 재작성하지 **않는다.** 현재의 named 필드 shape를 정본으로 유지하고, "binance-like"는 **문서 페이지의 구성·범위·스트림 네이밍** 수준에서 달성한다(스트림 이름은 이미 `<sym>@depth` 등 Binance식). 근거: FE가 named shape에 의존하고, 전면 재작성은 대규모·고위험인데 얻는 것은 Binance SDK 드롭인뿐(이 폐쇄 데모의 목표가 아님). API 문서는 ADR-042의 통합 docs 페이지가 **실제 named 페이로드**를 Binance식 레이아웃으로 보여준다.

### 2. futures 마켓 WS를 spot 파리티로 + 양쪽에 aggTrade
`/ws/fmarket`에 다음을 추가한다(스트림 이름·envelope·SUBSCRIBE 프로토콜은 spot과 동일):
- `{sym}@kline_{interval}` — **ADR-033 §5의 "futures kline WS 없음"을 supersede.** ADR-023 SQL 소스로 subscribe 시 백필, 1s 타이머로 현재 봉 갱신·봉 마감 시 isFinal 푸시(spot `tickKlines`와 동형).
- `{sym}@bookTicker` — `OrderBookCache.getBookTicker`를 DEPTH_DIFF에서 변경 시에만 푸시(spot `bookTickerIfChanged`와 동형).
- `{sym}@miniTicker` + `!miniTicker@arr` — 1s dirty-set 스로틀(spot과 동형).
- `!markPrice@arr` — 전 심볼 mark를 1s 배열로(per-symbol `{sym}@markPrice`는 유지).

spot·futures 양쪽에 `{sym}@aggTrade` 추가 — 기존 `TradeService.aggTrades` 집계를 `@trade` fanout과 나란히 송출(agg id·first/last trade id 포함은 가능 범위에서).

### 3. 코드 배치 — ADR-017 준수(복제 허용, base 미변경)
새 스트림 로직은 각 게이트웨이 **서브클래스**(`market.gateway.ts` / `futures-market.gateway.ts`)에 둔다. spot 서브클래스의 kline/bookTicker/miniTicker 로직을 futures 서브클래스로 **복제**한다. `libs/shared/src/ws/market-gateway.base.ts`(프로토콜·라이프사이클만)는 건드리지 않는다 — 스트림별 로직을 base로 끌어올리지 않는다(ADR-017).

### 4. FE — futures kline은 스트림 구독으로 전환
`use-futures-market.ts`의 5s REST 폴링을 제거하고 `{sym}@kline_{interval}` 구독으로 교체(spot 차트와 동형). 신규 스트림은 `useWsStream(<name>, path)`로 소비 — `BaseWsClient`/`WsClient` base 변경 불필요.

## 범위 밖 (이번 결정 아님)
- byte-for-byte Binance 페이로드(§1에서 기각)
- `@forceOrder` 공개 청산 피드, combined-stream URL(`/stream?streams=`), true depth-diff(U/u 시퀀스, ADR-020 Phase-1 유지) — 유저가 이번 범위에서 제외.
- 모든 새 스트림은 **additive**, full-snapshot depth(ADR-020) 정책 불변.

## Consequences
- futures 마켓 UI가 spot 수준의 라이브 데이터(차트 in-bar, bookTicker, miniTicker)를 얻고 5s 폴링 부하·지연이 사라진다.
- ADR-033 §5(futures kline WS 제외)는 본 ADR로 뒤집힌다. 그 외 ADR-033 표면은 유효.
- spot/futures 게이트웨이 중복이 늘지만 ADR-017 정책상 의도된 비용 — 두 구현이 검증된 뒤에만 공통 추출.
- 페이로드 named 유지로 기존 FE·정합성 봇 무손상. Binance SDK 드롭인은 비목표.

## 관계
- [ADR-033](033-futures-api-surface.md): §5(futures kline WS 없음) supersede, 나머지 유효
- [ADR-017](017-product-split-inside-trading-only.md): spot↔futures 복제 허용 근거
- [ADR-020](020-orderbook-diff-and-be-reconstruction.md): full-snapshot depth 정책 불변(depth-diff 범위 밖)
- [ADR-023](023-kline-sql-single-source.md): kline 백필 SQL 소스 재사용
- [ADR-042](042-binance-like-api-docs.md): named 페이로드를 Binance식 레이아웃으로 문서화(예정)
