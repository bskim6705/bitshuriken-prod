# 028 — 실거래소에 없는 캔들 인터벌도 전략 목적으로 노출한다

**Rule.** 이 거래소는 미러 소스(Binance/Upbit)에 존재하지 않는 캔들 인터벌도 지원한다.
1s(및 향후 서브분 인터벌)는 마켓별 분기 없이 전 심볼(spot·futures·KRW)에 공통 노출한다 —
노출 인터벌 집합을 실거래소와 일치시키지 않는다.

**Why.** prod는 실거래소 기준으로 판단한다(feedback-024). 단 그 원칙은 **시장 메커니즘**
(체결·호가·정합성·틱·세션)에 적용되는 것이고, 노출하는 **조회 해상도**(캔들 인터벌)는 별개다.
이 거래소는 유저의 전략 테스트베드이며, 유저가 실거래소 봇을 돌려 미러하되 그 거래소에 없는
해상도(서브초/서브분)까지 자기 스캘핑·HFT 전략을 위해 쓰길 원한다. 실제로 Binance spot만 1s를
제공(Upbit·futures 없음)하지만, 전략 지원을 위해 전 심볼에 연다.

**How to apply.**
- 인터벌 추가는 `bitshuriken-prod-be/libs/core-domain/src/kline/intervals.ts` 단일 소스
  (`KLINE_INTERVALS` + `INTERVAL_MS`)에만. 캔들은 Trade 테이블 SQL 온디맨드 집계라 저장·백필 없음;
  다운스트림(exchange-info `klineIntervals`, WS `kline_<iv>` 파싱, REST kline)은 자동 전파.
- "실거래소엔 그 봉이 없으니 제거"식 authenticity 교정 금지 — 의도된 확장이다.
- 이 예외는 조회 해상도에 국한. 시장 메커니즘은 여전히 실거래소 기준(feedback-024) 유지.
