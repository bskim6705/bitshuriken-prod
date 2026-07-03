# ADR-021: Stop 주문은 BE 트리거 서비스로 구현

## Status
Accepted

## Context

Binance spot 패리티를 위해 STOP_LOSS / STOP_LOSS_LIMIT / TAKE_PROFIT / TAKE_PROFIT_LIMIT 주문이 필요하다.

핵심 제약:
- 매칭엔진은 수정 불가. 엔진 inbound op는 `NO`/`CO`뿐이고 주문 타입은 L/M/PO만 이해한다.
- 엔진은 가격 트리거 개념이 없다 — 조건부 주문은 누군가 last price를 보고 발화시켜야 한다.
- 실제 거래소들도 트리거 판정을 매칭 코어 밖(별도 트리거 시스템)에서 하는 경우가 많다.

## Decision

**Stop류 주문은 트리거 전까지 BE가 보관하고, last trade price가 조건을 충족하면 BE가 일반 주문(L/M)으로 엔진에 전송한다.**

1. **배치**: status `NEW`, `triggeredAt=null`로 DB 저장 + 잠금(§lock 규칙은 MARKET/LIMIT과 동일 패턴, market형 stop BUY는 quote-driven origQuoteQty). 엔진엔 안 보냄. TriggerRegistry(in-memory)에 등록.
2. **트리거 판정**: TickerStatsService trade 이벤트 구독. STOP_LOSS: BUY `last>=stop`, SELL `last<=stop`; TAKE_PROFIT: 반대. 기준은 last trade price (Binance spot 동일).
3. **발화**: registry 동기 제거 → guarded claim (`updateMany where status=NEW AND triggeredAt IS NULL`) → 엔진 NO emit (`*_LIMIT`→'L', 그 외→'M'). claim 실패 = 취소와의 레이스 패배 → 중단.
4. **미트리거 취소**: 엔진이 모르는 주문이므로 BE 로컬 취소 — 같은 guarded claim 패턴으로 status CANCELED 전이 후 잠금 환불 이벤트 INSERT. **주문 mutation은 엔진 경유(feedback-002)의 명시적 예외** — 엔진에 존재하지 않는 주문은 BE 소유.
5. **즉시 트리거 거부**: 배치 시점에 이미 조건 충족이면 400 (Binance 동일). last price는 in-memory → 최신 Trade row fallback.
6. **복구**: `triggeredAt!=null AND status=NEW`(발화 기록 후 NO 미전송 크래시)는 부트 후 settlement PENDING drain + 10s 지연 후 재확인하고 NO 재전송.

## Rationale

- 엔진 무수정 제약 하에서 유일하게 가능한 구조.
- 모든 상태 전이를 DB guarded updateMany로 중재 — 취소/트리거/이중발화 레이스를 단일 지점에서 해소.
- registry는 fast-path 캐시일 뿐 진실은 Order row.

## Consequences

- 트리거 레이턴시 = TR consume 레이턴시 (엔진 내장 트리거보다 느림). dev 플랫폼 수준에서 무시 가능.
- 트리거 직후 가격이 되돌아가도 이미 발화됨 — Binance와 동일한 의미론.
- 복구 재전송에는 잔여 리스크가 있다: 첫 NO가 엔진에 도달했는데 OU가 아직 in-flight인 정확한 순간이면 중복 NO가 된다 (limit형은 엔진 duplicate-id ValueError 크래시 가능). 10s 지연 + status 재확인으로 확률을 줄였고, 정확한 해소는 Kafka high-watermark drain 감지가 필요해 연기.
- trailingDelta는 후속 작업 (트리거 서비스에 watermark 추적 추가로 구현 가능).
