# ADR-041: User Data Stream 보강 — listenKeyExpired + 리치 이벤트

## Status
Accepted (2026-06-14)
> **[2026-09-16 배너]** M1([ADR-077](077-settlement-process-split-and-graceful-shutdown.md)) 이후 §3 positionUpdate·§4 per-fill executionReport·outboundAccountPosition은 **클라이언트에 도달하지 않는다** — 발행자(consume/settle 워커)는 settle 프로세스, 구독자(WS 게이트웨이)는 API 프로세스이고 사이가 in-process EventEmitter다. API 측 executionReport는 per-fill 필드가 null. 해법은 `be.user-events` 브로드캐스트 토픽(tps plan §5.2 M2 ④, [ADR-076](076-product-maturity-stages-and-blast-radius.md) §6-①).

## Context
WS 감사에서 user-data-stream(spot `/ws/user`, futures `/ws/fuser`)의 공백이 드러났다:
- **listenKey 만료/취소 시 in-band 통지 없음** — 그냥 `close(4401)`. FE의 4401 핸들러는 `wanted=false`로 **영구 정지**해 만료가 스트림을 조용히 죽인다(앱 재초기화 전까지).
- **MARGIN_CALL(청산 경고) 부재** — 유저는 `positionUpdate`가 LIQUIDATING을 반영하기 전까지 사전 경고를 못 받는다.
- **positionUpdate에 mark/UPNL/청산가 없음** — 라이브 청산 거리 렌더에 부족(FE가 REST 재조회에 의존).
- **executionReport per-fill 디테일 부족** — 마지막 체결가/량, 수수료, tradeId, (futures) 실현손익 없음.

페이로드 충실도는 [ADR-040](040-ws-market-stream-completion.md) 정책을 따른다: **named 필드 유지, Binance 단일문자 키로 재작성하지 않음.**

## Decision

### 1. listenKeyExpired in-band 이벤트 (spot+futures 공통 base)
`close(4401)`(취소/만료 sweep) **직전에** `{stream:'listenKeyExpired', data:{listenKey, ts}}`를 push한다. 공유 base(`libs/shared/src/ws/user-gateway.base.ts` + `listen-key.base.ts`)에서 1회 구현 → 두 스트림 모두 적용. FE(`user-client.ts`)는 이 이벤트를 받으면 **영구 정지 대신** user-data-stream을 재-POST(새 listenKey 발급)하고 재연결한다. 4401 close 자체는 유지(이벤트는 close 전에 도착).

### 2. MARGIN_CALL (futures, 사전 경고)
LiquidationMonitor가 포지션 평가 시 `marginRatio ≥ MARGIN_CALL_RATIO`(코드 상수, **기본 0.8** — 청산까지 20% 이내)면 `{stream:'MARGIN_CALL', data:{symbol, marginMode, marginRatio, markPrice, ts}}`를 `FuturesUserEventsService`로 push한다. cross는 계정 단위 ratio 1건으로 송출. **디바운스**: 유저+심볼(cross는 유저)별 "경고 발송됨" 셋을 두고 warn 밴드 **진입 시 1회만** 발송, 밴드 이탈/청산/NORMAL 복귀 시 셋에서 제거(매 tick 스팸 금지). 임계는 경제적 효과 없는 알림 전용이며 상수로 조정 가능(운영자 확정 대상 — 기본값 채택).

### 3. positionUpdate 보강 — mark/UPNL/청산가 (실용 범위)
`FuturesPositionSnapshot`에 `markPrice`, `unrealizedPnl`, `liquidationPrice`를 추가한다. emit 시점에 mark가 있으면 채우고 없으면 null:
- `markPrice`, `unrealizedPnl` — 현재 mark 기준(MarkPriceService). 저렴.
- `liquidationPrice` — **ISOLATED만** emit 시 계산(단일 행 닫힌 식). **CROSS는 계정 의존 추정가라 per-position push에 부적합 → null**, FE는 REST(`GET /futures/account/positions`)로 보충(account-service가 cross 추정가 계산). 이 비대칭은 의도된 절충.

### 4. executionReport per-fill 디테일 (spot+futures)
`executionReport`에 `lastFilledQty`, `lastFilledPrice`, `commission`, `commissionAsset`, `tradeId`, (futures) `realizedPnl`를 추가한다. 값은 이미 TR/정산 페이로드에 존재 — emit 지점(spot `execution-report.ts` 송출부, futures `futures-match-result.service`)에서 누적 필드 옆에 스레딩한다. 기존 누적 필드(executedQty/cumulativeQuoteQty/status)는 불변.

## 범위 밖
- balanceUpdate delta 이벤트, ACCOUNT_UPDATE reason 코드, 이벤트 시퀀스/replay, 멀티 인스턴스(Redis pub/sub) — 이번 범위 아님(ADR-024의 단일 인스턴스 제약 유지).
- cross positionUpdate 라이브 청산가(추정가는 REST로만).

## Consequences
- listenKey 만료가 더는 스트림을 조용히 죽이지 않음 — FE 자동 재발급으로 세션 연속성 확보.
- futures 유저가 청산 전 경고를 받음. MARGIN_CALL 임계(0.8)는 상수 — 운영자가 조정 가능.
- positionUpdate가 isolated에 한해 라이브 청산가까지 자급. cross는 REST 보충(문서화된 비대칭).
- executionReport가 마지막 체결·수수료·실현손익을 실어 FE가 체결 토스트/실현손익을 스트림만으로 렌더 가능.
- named 페이로드 유지로 기존 FE/봇 무손상(ADR-040).

## 관계
- [ADR-024](024-user-data-stream.md): user-data-stream 원형 — 본 ADR이 이벤트/라이프사이클 보강
- [ADR-040](040-ws-market-stream-completion.md): named 페이로드 충실도 정책 공유
- [ADR-031](031-liquidation-insurance-fund.md): 청산 모니터 — MARGIN_CALL 발송 지점
- [ADR-039](039-cross-margin-per-position-toggle.md): cross 계정 단위 ratio/추정 청산가 근거
- [feedback-016](../feedback/016-policy-decisions-ask-user.md): MARGIN_CALL 임계는 운영자 조정 대상(기본값 채택, 알림 전용)
