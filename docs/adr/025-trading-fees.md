# ADR-025: 거래 수수료 — 유저별 bps, 정산 시점 수령 자산 차감

## Status
Accepted

## Context

Binance 패리티에 수수료(commission)가 포함된다 — account commission rates, myTrades의 commission 필드. 제약:
- 매칭엔진은 수수료를 모른다 (수정 불가) — 가격/수량 매칭만.
- 정산은 SettlementEvent 로그 경유 (ADR-014). 잠금(debit) 산식은 dust 환불 회계와 맞물려 있어 건드리면 위험.

## Decision

1. **요율은 User row에 bps로** (`feeMakerBps`/`feeTakerBps`, 기본 10 = 0.1% — Binance 표준 요율 참조). 조회는 `UserService.feeRatesOf` 60s TTL 캐시, **유저 없으면 throw(기본값 대체 금지), 범위 [0,10000) 검증**.
2. **차감은 수령 자산에서, 정산 시점에**: `recordTrade`의 credit leg에서 `commission = gross × bps/10000` floor 8dp, `creditDelta = gross - commission`. **같은 commission Decimal을 같은 트랜잭션의 Trade row에 기록** (maker/taker별 commission + 자산). 불변식: `creditDelta + commission == gross`.
3. **debit(잠금) leg 무변경** — 수수료는 수령 자산이므로 잠금/환불 회계와 독립.
4. **수취 계정 없음 (소각)** — dev 플랫폼 정책. 수익화가 필요하면 fee wallet leg 추가로 확장.
5. `GET /spot/account/commission` 으로 요율 노출, myTrades에 본인 측 commission만 노출 (상대방 수수료/식별자 비노출).

## Rationale

- 수령 자산 차감은 Binance spot 기본 동작 (BNB 할인 미구현)과 동일.
- 정산 시점 단일 지점 적용이라 엔진/잠금/환불 어디에도 침습 없음.

## Consequences

- self-trade(STP 미구현)에서도 양측 수수료가 각각 부과된다 — 의도된 동작.
- 수수료 변경은 DB 수정으로만 가능 (요율 변경 API 없음 — 범위 밖). TTL 60s 내 stale 가능.
- 소각이므로 시스템 총자산은 체결마다 수수료만큼 감소한다.
