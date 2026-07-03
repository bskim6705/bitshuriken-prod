# ADR-003: 수량 필드는 `amount`로 통일

## Status
Superseded by [ADR-009](009-naming-qty-and-market-fields.md)

## Context
주문 수량을 표현하는 필드로 거래소마다 `quantity`, `qty`, `size`, `amount` 등을 섞어 쓴다. 우리 코드베이스에서도 Order/Trade는 `quantity`, Ticker는 `amountPrecision`으로 일관성이 깨져 있었다.

## Decision
수량 필드는 모든 곳에서 `amount`로 통일한다.

## Rationale
- Ticker가 이미 `amountPrecision`을 사용하고 있어, `amount`로 통일하면 "amount의 precision"이라는 의미가 자연스럽게 연결된다.
- `quantity`로 가면 `quantityPrecision`으로 Ticker도 바꿔야 하고, 변경 범위가 더 넓다.
- 거래소 관습은 `quantity`/`qty`/`size`가 다수파지만, 우리는 spot/futures/options를 단일 스키마로 처리하므로 외부 관습보다 내부 일관성을 우선한다.

## Consequences
- Order, Trade의 `quantity` 필드를 `amount`로 변경.
- 외부 거래소 API와 통신할 때는 매핑 레이어가 필요할 수 있다 (e.g., Binance `quantity` -> 내부 `amount`).
