# ADR-026: MARKET/IOC 부분체결 종결은 EXPIRED로 기록

## Status
Accepted

## Context

엔진 계약: MARKET 또는 IOC taker가 부분체결로 끝나면 **최종 OU status가 `P`(PARTIAL)** 다 — 잔여는 엔진이 버리고 추가 OU는 오지 않는다.

기존 BE는 PARTIAL을 비종결로 취급했다. 결과(버그):
- 부분체결 MARKET/IOC 주문이 영구히 open으로 남음 (open orders 오염).
- 종결 처리에 걸려 있는 dust 환불이 영영 실행되지 않아 잔여 잠금이 동결됨.

## Decision

**OU `P` 수신 시 주문이 market-like 타입(MARKET/STOP_LOSS/TAKE_PROFIT)이거나 `timeInForce=IOC`면 종결로 간주하고 DB status를 `EXPIRED`로 기록한다.** 종결이므로 dust 환불(또는 OCO 리스트 환불 경로)이 실행된다. LIMIT GTC의 P는 기존대로 PARTIAL(비종결, book 거주 중).

Binance 의미론 참조: IOC 부분체결 종결 주문의 최종 상태는 EXPIRED (executedQty > 0).

## Rationale

- 엔진의 P는 "체결이 있었다"는 사실만 담고 종결 여부는 타입/TIF로만 판별 가능 — BE 측 매핑이 불가피.
- 기존 enum(EXPIRED)을 재사용해 스키마 변경 없이 Binance와 같은 외형.

## Consequences

- FE/API 소비자는 EXPIRED + executedQty>0 = "부분체결 후 잔여 소멸"로 해석한다.
- 취소 거부 대상이 CANCELED/FILLED에서 terminal 전체(FILLED/CANCELED/REJECTED/EXPIRED)로 확장됨.
- 엔진의 `E`(EXPIRED) 코드는 여전히 미발행 — 이 EXPIRED는 BE가 부여하는 상태다.
