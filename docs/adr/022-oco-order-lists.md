# ADR-022: OCO 주문 리스트 — 리스트 단위 잠금 + DB-주도 상태머신

## Status
Accepted

## Context

OCO(One-Cancels-Other)는 limit 레그(book에 거주)와 stop 레그(BE 보관, ADR-021)의 묶음이다. 두 레그는 같은 자금을 공유하므로:
- 레그별로 잠그면 잔고가 두 배 필요 → 리스트 단위 1회 잠금이어야 한다.
- 레그별 dust 환불(기존 per-order 패턴)을 그대로 쓰면 잠근 적 없는 레그가 환불되어 자금이 생성된다.
- 엔진은 cancel ack가 없다(존재하지 않는 주문 CO에 무응답). stop 발화 시 "limit 취소 → stop 전송"의 원자성이 불가능하다.

## Decision

1. **잠금은 OrderList 단위 1회** (`lockAssetSymbol`/`lockAmount`): SELL은 base qty, BUY는 `max(price, stopLimitPrice) * qty`. 레그 Order row는 개별 잠금 없음.
2. **per-order 환불 전면 억제**: `orderListId != null`인 주문은 어떤 경로(OU terminal, 로컬 취소, P-terminal)에서도 per-order 환불 금지. 환불은 리스트 종결 시 `listref:{listId}` 이벤트 1건 = `lockAmount - used(체결 레그)`.
3. **stop 레그는 STOP_LOSS_LIMIT 한정** — market형 stop 레그는 BUY 잠금액 상한 산정 불가.
4. **limit 레그는 LIMIT GTC** (POST_ONLY 아님) — 배치 시 가격 관계 검증(SELL: `price > last > stopPrice`, BUY: 반대)으로 즉시 체결을 막으므로 R-거부 롤백 복잡도를 피한다.
5. **Flow B (stop 트리거) 시퀀싱**: stop NO를 바로 보내지 않는다. ① `stopPendingAt` guarded 기록 + limit 레그 CO 전송 → ② limit 레그 terminal OU 도착 시: `eq==0`이면 stop 레그 arming(guarded claim) 후 NO 전송, `eq>0`이면 stop 레그 로컬 취소. **이로써 두 레그 동시 집행이 구조적으로 불가능.**
6. **상태머신은 DB-주도 멱등**: 모든 결정(onLegExecuted / onLegTerminal / finalize)은 guarded updateMany 전이로 중재하고, in-memory 표식(trigger-pending)과 무관하게 OCO 레그의 모든 terminal OU가 상태머신을 통과한다. eq/cqq 판단은 OU 메시지 값 사용 (DB 반영은 worker 비동기라 stale).
7. **레그 단독 취소는 리스트 취소로 라우팅** (Binance 의미론).
8. **복구**: 부트 시 settlement PENDING drain 후 — `stopPendingAt` 있고 limit 비terminal이면 CO 재전송(무해); limit terminal + stop NEW면 onLegTerminal 재실행; 양 레그 terminal + EXECUTING이면 finalize 재실행(잠금 누수 방지).

## Rationale

- limit 취소 확인(OU C) 후에만 stop을 보내는 시퀀싱이 이중 집행과 환불 회계 깨짐을 동시에 막는 유일한 안전선 — 엔진 cancel-ack 부재 때문에 "이미 terminal이면 즉시 진행" 분기가 필수다.
- 환불을 리스트 단위 단일 이벤트로 모으면 sourceKey unique가 멱등성을 공짜로 보장.

## Consequences

- stop 발화 → 실제 주문 활성화 사이에 엔진 왕복 1회의 지연.
- `pricePrecision + qtyPrecision <= 8` 불변식 필요 (엔진 cqq의 per-fill floor와 BE 잠금 산식의 일치 조건; seed에서 강제).
- 수령 자산 수수료(ADR-025)는 환불 회계와 독립 (환불은 지불 자산).
- 단일 BE 인스턴스 전제 (in-memory registry/추적) — ADR-024와 동일.
