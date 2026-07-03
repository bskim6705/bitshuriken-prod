# ADR-009: 수량 필드는 `qty`로 통일, MARKET 처리용 필드 도입

## Status
Accepted (supersedes [ADR-003](003-naming-amount-not-quantity.md))

## Context
ADR-003에서는 내부 일관성을 위해 수량 필드를 `amount`로 통일했다. 그러나 다음 이유로 결정을 뒤집는다:

- 거래소 도메인에서 사실상 표준은 `qty` (Binance, Bybit, OKX 등)
- Binance API/문서를 자주 참조할 텐데 매번 `amount ↔ qty` 머릿속 변환 비용이 누적된다
- `originQty` / `executedQty` 패턴이 표준이라 처음 보는 사람이 바로 이해함
- MARKET BUY를 지원하려면 `origQuoteQty`, `cumulativeQuoteQty` 같은 필드가 필요한데, 이미 `Qty`로 끝나는 명명이 자연스럽다

또한 MARKET BUY는 base 수량을 미리 알 수 없으므로 quote 수량으로 입력받는 거래소 표준 방식을 도입한다.

## Decision

### 1. 명명 통일
모든 수량 필드는 `qty`를 사용한다 (`amount` 금지).

| 변경 전              | 변경 후              |
| -------------------- | -------------------- |
| `Ticker.amountPrecision` | `Ticker.qtyPrecision`    |
| `Order.amount`           | `Order.origQty`          |
| `Order.filled`           | `Order.executedQty`      |
| `Trade.amount`           | `Trade.qty`              |

### 2. MARKET 처리용 필드 추가 (Binance 표준)

`Order` 모델:

| 필드                  | 타입              | 설명                                                                  |
| --------------------- | ----------------- | --------------------------------------------------------------------- |
| `price`               | `Decimal?`        | LIMIT/POST_ONLY는 필수, MARKET은 null                                 |
| `origQty`             | `Decimal?`        | base 단위 요청 수량. LIMIT, MARKET SELL, MARKET BUY (by base)         |
| `origQuoteQty`        | `Decimal?`        | quote 단위 요청 수량. MARKET BUY (by quote)만 사용                    |
| `executedQty`         | `Decimal default 0` | base 누적 체결량                                                     |
| `cumulativeQuoteQty`  | `Decimal default 0` | quote 누적 체결액 (가중평균 가격 계산용)                             |

**제약**: 한 주문에서 `origQty`와 `origQuoteQty`는 mutually exclusive (둘 중 정확히 하나만 set). 검증은 어플리케이션 레이어.

### 3. 명명 디테일
- `cumulativeQuoteQty`: Binance API는 `cummulativeQuoteQty`로 오타가 박혀 있다. 우리는 정상 영문 철자(`cumulative`)를 사용한다. Binance 응답 매핑 시 변환 레이어에서 처리.

## Rationale
- **외부 API 일관성 우선**: ADR-003은 내부 일관성을 우선했지만, 거래소 프로젝트는 외부 (Binance/Bybit) 데이터를 끊임없이 참조하므로 외부와의 매핑 비용이 더 크다.
- **MARKET BUY 지원의 필수 조건**: `origQuoteQty`가 없으면 "100 USDT 어치 BTC 사기" 같은 표준 시장가 매수를 표현할 수 없다.
- **`origQty` / `executedQty` 패턴**: 요청량과 실제 체결량을 명확히 분리. 부분 체결 / 정정 / 환불 처리에 모두 필요.
- **`cumulativeQuoteQty`**: 가중 평균 체결가를 정확하게 계산하려면 quote 누적값이 필요하다. base 누적과 가격으로 역산하면 부동소수점 누적 오차가 생긴다.

## Consequences

- **마이그레이션 필요**: 기존 `amount`/`filled` 컬럼 rename + 새 컬럼 추가. 개발 DB는 리셋으로 처리.
- **Application 검증 필요**: `origQty` / `origQuoteQty`의 mutual exclusion은 DB 제약으로 표현 어려우므로 DTO/서비스 레이어에서 강제.
- **잔고 잠금 로직 분기**:
  - LIMIT BUY: `price * origQty` quote 잠금
  - LIMIT SELL: `origQty` base 잠금
  - MARKET BUY (by base): 잠금 불가능 (price 미정) → 별도 정책 필요
  - MARKET BUY (by quote): `origQuoteQty` quote 잠금
  - MARKET SELL: `origQty` base 잠금
- **매칭엔진 메시지**: 매칭엔진은 여전히 단일 `qty` (base) 단위로만 매칭을 수행한다. MARKET BUY (by quote)는 BE에서 best ask를 참조해 base qty로 변환하거나, 매칭엔진이 quote 기반 매칭을 별도 지원해야 한다 (별도 결정 필요, 본 ADR 범위 외).
- **Trade.qty**는 base 단위로 통일. quote 환산은 trade row에서 derive (price * qty).
- **memory 업데이트 필요**: `project_naming_amount.md` → `project_naming_qty.md`.
