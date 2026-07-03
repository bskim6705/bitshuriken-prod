# ADR-017: Product split은 `trading/` 안에서만, account/market은 통합 유지

## Status
Superseded by [ADR-018](018-product-prefix-and-deployment-options.md).

본 ADR은 spot/futures가 같은 host에 사는 Bybit/OKX 스타일을 가정했다. ADR-018에서 외곽 prefix(`/spot`, `/futures`)로 결정이 바뀌면서 본 ADR의 trading 안 분리 정책은 더 이상 유효하지 않다.

## Context

[ADR-016](016-rest-folder-by-use-case.md)에서 REST 폴더를 use case 기준(`trading/`, `account/`, `market/`)으로 정리했다. 곧 spot 외에 futures, options 같은 product line이 추가될 가능성이 있고, 그 시점에 폴더/URL 분리 전략이 결정돼야 한다. 미리 결정해두지 않으면 ADR-016의 use case grouping이 쉽게 무너진다 (예: `src/rest/spot/trading/...` 식으로 product가 외곽 분류로 올라가면 use case grouping 자체가 사라짐).

조사한 패턴은 두 가지 학파:

- **Binance / Kraken / Coinbase**: product별 host 완전 분리 (`fapi.binance.com`, `dapi.`, `eapi.`), 별도 wallet, 일부는 별도 API key까지. 대부분 futures가 나중에 bolt-on으로 추가된 결과.
- **Bybit V5 / OKX v5**: 단일 host, functional grouping (`/trade`, `/market`, `/account`), product는 `category` / `instType` 파라미터. UTA(Unified Trading Account)로 wallet도 통합. 신세대 거래소가 redesign 시 의도적으로 선택한 패턴.

공통점: **매칭엔진은 모든 거래소가 product별로 분리**한다. spot/futures의 마진/청산/펀딩 메커니즘이 너무 달라서 같은 매칭 binary에 안 돌린다. 우리는 [ADR-010](010-kafka-topic-unification-for-ordering.md), [ADR-013](013-match-engine-lane-architecture.md)에서 이미 product별 매칭엔진 + product별 Kafka 토픽으로 분리되어 있음.

## Decision

**Product split은 `trading/` 안에서만 적용한다. `account/`와 `market/`은 use case grouping을 유지하고 product를 통합 응답으로 처리한다.**

### futures가 실제로 추가될 때의 폴더 모양

```
src/rest/
  trading/
    orders.controller.ts          # POST /trading/orders          (현재 spot 전용)
    orders.service.ts
    futures/                      # futures 전용. spot과 endpoint shape이 다른 것만
      orders.controller.ts        # POST /trading/futures/orders
      positions.controller.ts     # POST /trading/futures/positions/close
      leverage.controller.ts      # POST /trading/futures/leverage
    common/                       # spot/futures 공유 helper. **추출의 결과로만 생성**, 미리 만들지 않음
  account/                        # 통합. 응답이 spot+futures wallet 모두 포함
  market/                         # 통합. instType param 또는 path
```

### 핵심 규칙

> **`marketType`은 Kafka envelope, 매칭엔진 dispatch, persistence layer에만 존재한다. `trading/` 컨트롤러 안의 `if (marketType === FUTURES)` 분기로 새지 않는다.**

이 규칙이 깨지면 Option 3(완전 통합 + 거대한 if 분기) 함정에 빠진다.

### `account/` 통합 처리 예시

- `GET /account/wallets` → spot wallet + futures wallet을 한 응답에
- `GET /account/orders?market=spot|futures` → query param으로 필터, controller는 단일
- `GET /account/trades` → 모든 product의 trade 통합

### `market/` 통합 처리 예시

- `GET /market/tickers` → spot + futures ticker 모두
- `GET /market/depth?symbol=BTCUSDT&market=spot` → query param으로 product 선택

## Rationale

- **이미 가장 중요한 분리는 됨**: 매칭엔진 + Kafka topic이 product별. Binance식 분리의 절반은 이미 적용됨. BE까지 host 분리하는 추가 비용은 단일 dev MVP에서 정당화 안 됨.
- **Bybit/OKX 검증**: top-5 거래소가 단일 host + functional grouping + UTA로 운영. "product마다 host 분리해야 한다"는 본능은 새 거래소엔 틀림.
- **ADR-016 보존**: product를 외곽으로 올리면 use case grouping이 무너짐. trading 안에서만 분리하면 use case가 외곽에 유지됨.
- **endpoint 모양이 다른 것만 분리**: futures의 positions/leverage/funding은 spot에 없는 개념. 같은 path에 if로 욱여넣으면 god controller 발생. 다른 path로 분리해서 모양 차이를 폴더로 표현.
- **account/market 통합 유지**: wallet 조회, ticker 조회는 product가 달라도 응답 구조가 동일. 분리하면 FE가 두 endpoint를 합쳐야 하는 부담만 늘어남.

## Consequences

- **현재 시점 변경 없음**: spot만 살아있는 동안엔 `trading/`이 평평하게 유지됨. 빈 `trading/spot/`이나 `trading/common/` 폴더는 만들지 않음 (premature, [feedback-001](../feedback/001-no-premature-implementation.md))
- **futures 추가 시 작업**:
  - `trading/futures/` 신설
  - 기존 spot 컨트롤러는 그대로 두거나 (`POST /trading/orders`가 spot 의미), 또는 명시적으로 `trading/spot/`으로 이동 — 이건 그때 결정
  - account/market은 응답에 futures 데이터 추가만, 컨트롤러 분리 안 함
  - `common/`은 추출 결과로만 생성. spot에서 빠져나가는 helper가 생길 때만 만들어짐
- **trading 컨트롤러 코드 리뷰 시 체크 항목**: `if (marketType === ...)` 분기 발견되면 폴더 분리로 리팩터
- **Wallet 모델**: spot wallet과 futures wallet이 한 테이블에 marketType으로 구분되는 현재 schema는 그대로 (UTA 식). 향후 cross-product margin이 필요해지면 그때 재검토

## 관계
- [ADR-004](004-spot-first-then-futures.md): spot 먼저, futures 미리 추상화 금지 — 본 ADR이 그 원칙을 폴더 정책으로 구체화
- [ADR-010](010-kafka-topic-unification-for-ordering.md): Kafka topic이 이미 product별 분리됨
- [ADR-013](013-match-engine-lane-architecture.md): 매칭엔진이 product별 분리됨
- [ADR-016](016-rest-folder-by-use-case.md): 본 ADR이 보강. ADR-016 수정 없이 미래 결정만 추가
- [feedback-001](../feedback/001-no-premature-implementation.md): 빈 futures 폴더 만들지 않는 근거
