# ADR-033: Futures API surface — REST /futures/* + WS /ws/fmarket·/ws/fuser

## Status
Accepted

## Context

Futures MVP에 외부 인터페이스(REST + WS)가 필요하다. [ADR-018](018-product-prefix-and-deployment-options.md)이 외곽 product prefix와 "futures 작업 시 새 모듈, spot에 if 분기 금지"를 이미 결정했고, [ADR-016](016-rest-folder-by-use-case.md)이 use case 분류(trading=mutation, account=read, market=public read)를 정했다. 남은 결정은:

- futures 고유 mutation(leverage/margin 조정)이 어느 use case에 속하는가
- spot↔futures 자금 이동(transfer)의 경로와 안전 조건 — 비동기 정산([ADR-014](014-async-settlement-via-event-log.md))·청산과 레이스가 있다
- WS 채널 구조 — spot gateway를 건드릴 것인가, 복제할 것인가
- klines를 새로 구현할 것인가

## Decision

### 1. REST: `/futures/{trading|account|market}/*`

ADR-018 외곽 prefix + ADR-016 use case 분류를 그대로 적용한다. 컨트롤러/서비스 안 `if (marketType === FUTURES)` 분기 금지 — product는 폴더와 path로만 구분한다.

```
POST   /futures/trading/orders            {symbol, type(LIMIT|MARKET|POST_ONLY), side, timeInForce?, price?, qty, reduceOnly?}
DELETE /futures/trading/orders/:id
PATCH  /futures/trading/positions/:symbol {leverage} XOR {marginDelta}
GET    /futures/account/balances | positions | orders | trades | income
GET    /futures/market/tickers | depth | recent-trades | book-ticker | klines | mark-price | funding-rate
GET    /futures/market/exchange-info      (심볼별 precision/tickSize/stepSize/minNotional/maxLeverage — spot exchange-info 패턴 복제)
POST   /account/transfers                 {fromMarket, toMarket, assetSymbol, qty}
```

- **mutation은 전부 trading 아래.** leverage 변경·margin 증감은 포지션 read가 아니라 상태 변경이므로 `PATCH /futures/trading/positions/:symbol`이다 (ADR-016 분류상 account는 read 전용). leverage 변경은 qty==0일 때만 허용. marginDelta는 +면 balance→isolatedMargin(가용 검증), −면 잔여 margin ≥ mark notional/lev 검증.
- **transfers는 prefix 밖.** 자금 이동은 spot/futures 어느 한쪽 소유가 아닌 cross-product 행위 — ADR-018 §1의 "cross-product는 prefix 밖" 원칙을 따라 `POST /account/transfers`. 코드는 futures 모듈이 호스팅한다([ADR-027](027-futures-code-separation-and-deployment.md) 폴더 경계 내 `futures/http/transfers/`).

### 2. Transfer 안전 조건: 동기 트랜잭션 + 출금 게이트

transfer는 동기 트랜잭션으로 처리하고 수신측 wallet은 upsert한다(futures 첫 입금 시 wallet 없음). **futures→spot 출금은 해당 유저의 PENDING futures 정산 이벤트가 있거나 LIQUIDATING 포지션이 있으면 거부한다.** 정산이 비동기라 "아직 적용 안 된 손실/청산"이 있는 balance를 그대로 믿고 내보내면 자금 유출이 된다 — 출금 시점에 게이트로 레이스를 차단한다. 이동은 `FuturesIncome(TRANSFER)`로 기록한다.

### 3. 주문 접수: 검증 순서 고정 + NEW 반환

주문 접수 검증은 다음 순서로 고정한다: ticker/config 로드 → LIQUIDATING 거부 → 가격 밴드(LIMIT)/mark 존재 확인 → Ticker.minNotional → maxNotional(포지션+open 합산) → reduceOnly면 Σ(reduceOnly open qty)+qty ≤ Q 검증(잠금 없음) → 아니면 cost 계산·동기 잠금(balance→locked, `Order.lockedCost` 기록) → 엔진 NO 발행.

응답은 체결을 기다리지 않고 **NEW 상태의 주문을 즉시 반환**한다 ([feedback-004](../feedback/004-order-submit-must-return-pending.md)). 경로에 동사 금지 ([feedback-003](../feedback/003-restful-api.md)).

### 4. WS: `/ws/fmarket` + `/ws/fuser` — 복제, spot 무수정

- **`/ws/fmarket`** (public): `{sym}@depth`, `{sym}@trade`, `{sym}@ticker`, `!ticker@arr`, `{sym}@markPrice`(mark/index/lastFundingRate/nextFundingTime, 1s 주기). 기존 spot market gateway 패턴을 복제한 별도 gateway이며 **spot gateway는 수정하지 않는다**.
- **`/ws/fuser`** (auth): [ADR-024](024-user-data-stream.md)의 user-stream 패턴(쿠키 + listenKey)을 복제. 이벤트는 주문 업데이트·포지션 업데이트·잔고 업데이트(청산 통지 포함).

### 5. klines: 신규 구현 없음

`GET /futures/market/klines`는 [ADR-023](023-kline-sql-single-source.md)의 Trade 테이블 SQL 단일 소스를 그대로 재사용한다(market 파라미터만 FUTURES). in-memory 캔들 같은 신규 인프라를 만들지 않는다.

## Rationale

- **기존 결정의 적용이지 새 구조가 아님** — URL/폴더/분류는 ADR-016·018이 futures를 위해 예약해둔 자리를 채우는 것. 결정 비용과 학습 비용이 0에 가깝다.
- **leverage/margin PATCH를 trading에 둔 이유** — "mutation 여부 + 인증 종류"라는 ADR-016의 분류 기준을 일관 적용. account에 두면 read 전용 경계가 깨지고 god module로 회귀한다.
- **transfer 출금 게이트** — 비동기 정산의 대가를 출금 한 지점에서 지불하는 가장 싼 방법. 정산을 동기화하는 대안은 ADR-014를 뒤집는 비용이라 과하다.
- **WS 복제** — spot gateway 파라미터화는 spot 코드 수정(허용 목록 밖)이고, ADR-027의 "futures는 `src/futures/**` 밖에 두지 않는다" 경계와도 충돌한다. 패턴 복제가 경계를 지키면서 가장 단순하다.

## Consequences

- FE는 fmarket/fuser용 WS path 파라미터화만 하면 spot 훅 패턴을 그대로 복제할 수 있다.
- gateway 코드가 spot/futures 두 벌이 된다 — 의도된 중복(미래 별도 앱 분리의 전제). 공통화는 분리 시점에 재검토.
- transfer 게이트 때문에 정산 백로그가 큰 동안 출금이 일시 거부될 수 있다 — 자금 안전과 맞바꾼 의도된 동작.
- 선물 STOP/TP는 MVP 제외라 `/futures/trading/orders`는 LIMIT/MARKET/POST_ONLY만 받는다. 추가 시 [ADR-021](021-stop-orders-be-trigger.md) 트리거 패턴을 재사용한다.

## 관계
- [ADR-016](016-rest-folder-by-use-case.md): trading/account/market 분류 — leverage/margin PATCH의 trading 배치 근거
- [ADR-018](018-product-prefix-and-deployment-options.md): 외곽 product prefix + cross-product는 prefix 밖 — `/futures/*`와 `/account/transfers`의 근거
- [ADR-023](023-kline-sql-single-source.md): klines SQL 단일 소스 — futures가 그대로 재사용
- [ADR-024](024-user-data-stream.md): user-stream 패턴 — `/ws/fuser`가 복제
- [feedback-003](../feedback/003-restful-api.md): 동사 경로 금지
- [feedback-004](../feedback/004-order-submit-must-return-pending.md): 주문 제출은 NEW 즉시 반환
