# Binance Spot 기능 완성 — 설계/계약 문서 v2 (구현 에이전트용)

> 작업 지시의 단일 소스. 모든 구현 에이전트는 이 문서의 계약을 따른다. v2 = 적대적 설계 리뷰 반영본.
> 매칭엔진(bitshuriken-v2-match)은 **절대 수정 금지** (읽기만 허용).
> STP(self-trade prevention)는 의도적으로 제외.

## 0. 전제 (기존 시스템 요약)

- 엔진 inbound op: `NO`(신규), `CO`(취소)만. 주문 타입 `L`/`M`/`PO`, TIF `G`/`I`/`F`.
- 엔진 outbound: `TR`(체결), `OU`(주문상태: N/O/P/F/C/R/E — N,E는 미발행), `DPD`(북 diff, 별도 토픽).
- **엔진 계약 핵심 사실** (구현 시 절대 잊지 말 것):
  - MARKET/IOC taker 부분체결의 최종 OU status는 `P` (잔여는 엔진이 버림).
  - 존재하지 않는 주문에 CO를 보내면 엔진은 **아무것도 발행하지 않는다** (ack/에러 없음).
  - NO에 중복 방지 없음 — 같은 id의 NO 재전송은 이중 집행(또는 resting 중복 id ValueError로 엔진 전체 크래시) 위험.
  - maker partial fill마다 OU `P`가 반복 발행된다 (status 동일, eq 증가).
  - 한 inbound 메시지 처리 결과는 TR* → OU* → DPD 순서로 발행, 파티션 내 순서 보장.
  - 엔진 cqq는 per-fill 정수 floor (`fill_qty*price//10^8`).
- Kafka 숫자는 `int*10^8`의 string. BE 내부 Prisma Decimal. WS/REST 응답은 사람이 읽는 decimal string (toFixed(precision)).
- 1 ticker = 1 partition (`Ticker.partition`), 토픽 `match.{spot|futures}.{in|out|book}`.
- REST 배치: `/spot/market`(공개) / `/spot/account`(PrivateGuard, 자기 데이터 read, Prisma만) / `/spot/trading`(PrivateGuard, mutation, Kafka 허용) / `/auth`. (+신설 `/spot/user-data-stream` §8)
- 응답 envelope `{code:0,message:'ok',data}` 자동 래핑. 에러는 HttpException throw.
- 주문 mutation: DB에 NEW row 저장 → HTTP 응답 반환 → Kafka emit (feedback-004).
- Wallet 변경: hot-path는 SettlementEvent INSERT만, worker(100ms)가 적용 (placement lock만 동기).
- OU 핸들러는 status만 동기 기록; **DB의 executedQty/cumulativeQuoteQty는 worker가 비동기 반영하므로 즉시성 판단에 DB eq/cqq를 쓰지 말 것** — 의사결정은 OU 메시지의 eq/cqq 사용.
- FE: Next.js 16.2.2(작성 전 node_modules/next/dist/docs 확인; params는 Promise), Tailwind v4 토큰, 숫자는 display-ready string 그대로 표시. UI 텍스트 영어 전용. 도메인 목록(주문타입/인터벌 등)은 BE API에서 (feedback-015).
- **정합성 전제 (테스트로 보장)**: 모든 ticker는 `pricePrecision + qtyPrecision <= 8` (엔진 floor와 BE 정산 lock 산식의 일치 조건). tick/step 검증은 엔진으로 가는 **모든** placement 경로(일반 주문, 트리거된 stop, OCO 레그)에서 수행 — 정산 잠금 회계의 정확성 전제조건.

## 1. Prisma 스키마 변경 (schema.prisma만 수정; 마이그레이션 파일 생성/실행 금지)

```prisma
enum OrderType {
  MARKET
  LIMIT
  POST_ONLY
  STOP_LOSS          // 트리거 시 'M'으로 엔진 전송
  STOP_LOSS_LIMIT    // 트리거 시 'L'로 엔진 전송
  TAKE_PROFIT        // 'M'
  TAKE_PROFIT_LIMIT  // 'L'
}

enum ContingencyType { OCO }
enum OrderListStatus { EXECUTING ALL_DONE REJECTED }

model Order {
  // 기존 필드 유지 + 추가:
  stopPrice    Decimal?   @db.Decimal(32, 8)
  triggeredAt  DateTime?                      // null = 미트리거(BE 보관)
  orderListId  String?
  updatedAt    DateTime   @updatedAt
  orderList    OrderList? @relation(fields: [orderListId], references: [id])

  @@index([userId, status])
  @@index([userId, tickerSymbol, tickerMarket, createdAt])
}

model OrderList {
  id              String          @id @default(uuid())
  userId          String
  tickerSymbol    String
  tickerMarket    MarketType
  side            OrderSide
  contingencyType ContingencyType
  status          OrderListStatus @default(EXECUTING)
  cancelRequested Boolean         @default(false) // 유저 리스트 취소 표식 — step-2 arming 차단
  stopPendingAt   DateTime?       // Flow-B step 1 표식 (트리거됨, limit 레그 취소 대기) — 크래시 복구용
  lockAssetSymbol String
  lockAmount      Decimal         @db.Decimal(32, 8) // 리스트 단위 잠금 (레그별 잠금 없음)
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
  user   User    @relation(fields: [userId], references: [id])
  orders Order[]
  @@index([userId, createdAt])
}

model Trade {
  // 기존 + 추가:
  seq        Int      @unique @default(autoincrement()) // 삽입순서 = 파티션 내 엔진 발행 순서. OHLC tie-break용. API 응답에 노출 금지(select로 제외)
  executedAt DateTime @default(now())                   // 엔진 ts (진짜 체결 시각). kline 버킷 기준
  makerCommission      Decimal @default(0) @db.Decimal(32, 8)
  takerCommission      Decimal @default(0) @db.Decimal(32, 8)
  makerCommissionAsset String?
  takerCommissionAsset String?

  @@index([tickerSymbol, tickerMarket, executedAt])
  @@index([makerUserId, createdAt])
  @@index([takerUserId, createdAt])
}

model User {
  // 기존 + (Binance 표준 0.1% = 10 bps; 유효범위 0 <= bps < 10000, feeRatesOf에서 검증):
  feeMakerBps Int @default(10)
  feeTakerBps Int @default(10)
}

model Wallet {
  // 기존 + (outboundAccountPosition 순서 역전 방지 — FE가 자산별 max(ts) 유지):
  updatedAt DateTime @updatedAt
}

model Ticker {
  // 기존 + (0 = 제한 없음; seed에서 USDT/USDC 페어는 5):
  minNotional Decimal @default(0) @db.Decimal(32, 8)
}
```

- `prisma/seed.ts`: ticker upsert에 `minNotional` (quote USDT/USDC → `5`, 그 외 `0`).
- `SettlementService.recordTrade`는 Trade 생성 시 `executedAt: new Date(ts)` (TR 메시지 ts) 명시. `TickerStatsService` rehydrate도 executedAt 기준으로 변경.
- 마이그레이션은 사용자가 직접 실행 (`npx prisma migrate dev --name binance_spot_features`). 에이전트는 `npx prisma generate`만.

## 2. Stop 주문 (BE 트리거 — 엔진 무수정)

### 2.1 의미론 (Binance 동일)
- 트리거 기준: last trade price.
- STOP_LOSS(_LIMIT): BUY `last >= stopPrice`, SELL `last <= stopPrice`.
- TAKE_PROFIT(_LIMIT): BUY `last <= stopPrice`, SELL `last >= stopPrice`.
- 트리거 전: status `NEW`, `triggeredAt=null` (open orders에 노출).
- **market-like 타입 집합** = {MARKET, STOP_LOSS, TAKE_PROFIT} / **limit-like** = {LIMIT, POST_ONLY, STOP_LOSS_LIMIT, TAKE_PROFIT_LIMIT}. 이 분류를 단일 헬퍼(`shared` 또는 order 도메인)로 정의하고 검증·잠금·환불·직렬화 전부 이걸 쓴다.

### 2.2 검증/잠금 (placement)
| type | side | 필수 | 잠금 |
|---|---|---|---|
| STOP_LOSS / TAKE_PROFIT | BUY | stopPrice, origQuoteQty | quote: origQuoteQty |
| STOP_LOSS / TAKE_PROFIT | SELL | stopPrice, origQty | base: origQty |
| *_LIMIT stop | BUY | stopPrice, price, origQty | quote: price*origQty |
| *_LIMIT stop | SELL | stopPrice, price, origQty | base: origQty |
- 즉시 트리거 조건 충족이면 400 "Order would trigger immediately." last price는 TickerStats lastPrice → null이면 최신 Trade row fallback (`findFirst orderBy seq desc`) → 그것도 없으면(체결 이력 전무) 검사 생략.
- tick/step/minNotional 검증 (§5) 적용.

### 2.3 직렬화 (match-message.serializer.ts — **명시적 변경 지점**)
- `TYPE_CODE`에 추가: `STOP_LOSS→'M'`, `TAKE_PROFIT→'M'`, `STOP_LOSS_LIMIT→'L'`, `TAKE_PROFIT_LIMIT→'L'`.
- 매핑 누락 시 **throw** (undefined를 직렬화해 엔진 전체를 죽이는 사고 방지).
- stop 주문 NO의 `p`: limit-like는 price, market-like는 미포함(기존 MARKET과 동일).

### 2.4 TriggerRegistry / TriggerService
- `domain/trigger/trigger-registry.service.ts`: 순수 in-memory. `add(order)`, `remove(orderId)`, `pendingFor(market, symbol)`. 의존성 없음.
- `domain/trigger/trigger.service.ts`:
  - rehydrate: `onApplicationBootstrap`에서 `stopPrice != null AND triggeredAt = null AND status = NEW` 스캔 (기존 TickerStats 패턴 — 컨슈머 시작 전 완료).
  - `TickerStatsService.onTrade` 구독. **리스너의 registry 확인/제거는 어떤 await보다 먼저 동기 실행** (한 sweep의 다중 TR로 인한 이중 트리거 방지).
  - 트리거 절차(plain stop): registry 동기 제거 → **guarded claim**: `updateMany({where:{id, status:'NEW', triggeredAt:null}, data:{triggeredAt:now}})` — count 0이면 중단(취소와의 레이스에서 패배) → 엔진 NO emit (underlying L/M) → executionReport emit. DB/Kafka 실패 시 registry 복원 + 에러 로그.
  - OCO stop 레그는 OrderListService.onStopTriggered로 위임 (§3).
- 미트리거 stop 취소 (DELETE /orders/:id 경로): **guarded claim**: `updateMany({where:{id, status:'NEW', triggeredAt:null}, data:{status:'CANCELED'}})` — count 1이면 registry 제거 + (orderListId 없을 때만) `dust:{orderId}` 환불 이벤트 INSERT + executionReport. count 0이면 이미 트리거됨 → 일반 CO 경로로 진행.
- 평가 순서: 같은 TR에 대해 OCO 컨틴전시(handleTrade 내 await) → tickerStats.applyTrade(→ trigger 평가) — match-result.controller의 기존 호출 순서가 이미 이를 보장. OrderListService.onLegExecuted는 handleTrade 안에서 **await**.
- 복구(armed-but-unsent): 부트 후 지연 복구 작업 — `status='NEW' AND triggeredAt != null`(plain stop) 스캔을 부트 +10s에 실행, 재확인 후에도 status NEW면 NO 재전송. 그 전에 settlement PENDING drain 대기 (`count==0`까지 폴링, 타임아웃 시 큰 로그). Kafka 백로그의 OU가 그 사이 처리되면 status가 바뀌어 자연 스킵. 잔여 리스크(정확히 in-flight인 OU)는 ADR에 기록.

### 2.5 기존 버그 수정 — MARKET/IOC 부분체결 종결 처리 (match-result.service.ts)
- OU `P` 수신 시 해당 주문이 market-like 타입 **또는** `timeInForce=IOC`면 종결 — DB status `EXPIRED` 기록 (Binance: IOC/MARKET 부분체결 종결 시 EXPIRED). 종결 처리이므로 환불 경로 진입.
- LIMIT GTC의 P는 기존대로 PARTIAL(비종결).
- **환불/리스트 가드**: 종결 진입 시 `orderListId != null`이면 per-order dust refund **금지**, OrderListService.onLegTerminal로 위임. (이 가드는 §2.4 로컬 취소, §2.5, 기존 terminal 처리 전부에 적용 — per-order 환불은 orderListId == null일 때만.)
- `submitCancelOrder` 거부 대상을 전체 terminal 집합(FILLED/CANCELED/REJECTED/EXPIRED)으로 확장.

### 2.6 computeRefund 수정 (settlement.service.ts — **명시적 변경 지점**)
- market-like BUY → 잠금 origQuoteQty, 사용 cqq (quote 환불).
- limit-like BUY → 잠금 price*origQty, 사용 cqq.
- SELL 전부 → 잠금 origQty, 사용 eq (base 환불).
- eq/cqq는 호출자가 OU 메시지 값으로 전달 (기존 패턴 유지).

## 3. OCO 주문 리스트 — DB-주도 멱등 상태머신

### 3.1 API
- `POST /spot/trading/order-lists` body:
  `{ tickerSymbol, tickerMarket:'SPOT', side, qty, price, stopPrice, stopLimitPrice, stopLimitTimeInForce }`
  - stop 레그는 STOP_LOSS_LIMIT 한정 (market형 stop 레그는 BUY 잠금액 산정 불가 — ADR 기록).
  - 가격 관계 검증: SELL → `price > last > stopPrice`; BUY → `price < last < stopPrice`. last는 §2.2와 동일 fallback, 끝내 없으면 400.
  - 응답 `{ orderList, orders:[limitLeg, stopLeg] }` (DB 저장 후 반환, 그 후 limit 레그 NO emit).
- `DELETE /spot/trading/order-lists/:id` — 아래 취소 흐름.
- `DELETE /spot/trading/orders/:id`에서 대상이 OCO 레그면 **리스트 전체 취소로 라우팅** (Binance 의미론).
- `GET /spot/account/order-lists?limit=`.

### 3.2 배치
- limit 레그: `LIMIT GTC` 즉시 엔진 전송. stop 레그: `STOP_LOSS_LIMIT` BE 보관 (registry 등록), tif=stopLimitTimeInForce.
- 잠금 (리스트 단위 1회, OrderList.lockAssetSymbol/lockAmount):
  - SELL: base `qty` / BUY: quote `max(price, stopLimitPrice) * qty`.

### 3.3 상태머신 (OrderListService — 모든 전이는 guarded updateMany 멱등)
**불변식: orderListId != null인 주문에 per-order 환불 경로(어디서든) 금지. 환불은 `listref:{listId}` 단 1회.**

- **onLegExecuted(orderId)** — handleTrade에서 체결 주문의 orderListId 감지 시 await 호출:
  - 리스트 로드. stop 레그가 아직 NEW+미트리거면 guarded 로컬 취소(§2.4 claim과 동일) + registry 제거 + stopPendingAt 클리어. 멱등.
- **onStopTriggered(stopLeg)** — Flow B step 1:
  - limit 레그 DB status 확인: **이미 terminal이면** 즉시 step 2 로직으로 (OU를 기다리지 않음 — 엔진은 unknown CO에 무응답).
  - 아니면: `orderList.updateMany({where:{id, stopPendingAt:null, cancelRequested:false, status:'EXECUTING'}, data:{stopPendingAt:now}})` — count 0이면 중단. 성공 시 limit 레그 CO emit. (registry에서 stop 레그는 이미 동기 제거됨)
- **onLegTerminal(listId, hint?)** — OCO 레그의 모든 terminal OU 처리 + BE 로컬 전이 후 호출. hint = `{orderId, eq, cqq}` (OU 메시지 값). trigger-pending 메모리 상태와 무관하게 **항상** 동작:
  - limit 레그 terminal & stop 레그 NEW+미트리거:
    - limit이 CANCELED & eq==0 (hint 기준) & `cancelRequested==false` → **step 2 arming**: stop 레그 guarded claim(`status NEW, triggeredAt null → triggeredAt=now`) — count 1이면 NO emit + stopPendingAt 클리어. count 0이면 (취소 레이스 패배) 로컬 취소 경로로.
    - 그 외 (limit 체결 있었음 / FILLED / REJECTED / 리스트 취소 요청) → stop 레그 guarded 로컬 취소.
  - 두 레그 모두 terminal → **finalize**: `orderList.updateMany({where:{id, status:'EXECUTING'}, data:{status: <REJECTED if 양 레그 모두 무체결 거부 else ALL_DONE>}})` — count 1일 때만 `listref:{listId}` 환불 INSERT (sourceKey unique가 이중 INSERT 차단):
    - 환불액 = `lockAmount - used(체결 레그)` — BUY는 cqq(quote), SELL은 eq(base). 체결 레그 없으면 전액. 사용값은 OrderListService가 레그별 최종 OU에서 추적한 값(hint) 또는 복구 경로에서는 drain 후 DB 값.
  - listStatus user-stream 이벤트 발행.
- **cancelList(listId)** — 유저 취소:
  - `updateMany({where:{id, status:'EXECUTING', cancelRequested:false}, data:{cancelRequested:true}})` — count 0이면 400/멱등 무시.
  - stop 레그: NEW+미트리거면 guarded 로컬 취소+registry 제거(트리거와의 레이스는 guarded claim이 중재); 이미 엔진에 있으면(armed) CO emit.
  - limit 레그: 비terminal이면 CO emit.
  - 이후 onLegTerminal 흐름이 자연 finalize.
- **부트 복구** (settlement PENDING drain 후 +10s, §2.4와 동일 작업 내):
  - `stopPendingAt != null` & limit 레그 비terminal → CO 재전송 (CO는 unknown-id 무해).
  - limit 레그 terminal & stop 레그 NEW(미/이미트리거 모두) → onLegTerminal 재실행 (DB 값 사용 — drain 완료로 authoritative).
  - 양 레그 terminal & status EXECUTING → finalize 재실행 (lock 누수 방지).
  - OCO stop 레그 `triggeredAt != null AND status NEW` → §2.4 armed-but-unsent 복구와 동일 (재확인 후 NO 재전송).

## 4. 수수료

- 요율: `User.feeMakerBps/feeTakerBps`. `UserService.feeRatesOf(userId)` — 60s TTL 캐시, **유저 없으면 throw(기본값 대체 금지), bps 범위 [0,10000) 검증 throw**. 성공 조회만 캐시.
- 적용: `recordTrade` credit leg에서 — `commission = gross.mul(bps).div(10000).toDecimalPlaces(8, ROUND_DOWN)`; `creditDelta = gross.sub(commission)`; **동일 commission Decimal을 같은 $transaction의 Trade row에 기록** (makerCommission/takerCommission + 자산). 불변식: creditDelta + commission == gross.
- commission 자산 = 그 당사자가 수령하는 자산 (BUY → base, SELL → quote).
- debit(잠금) leg 산식 무변경. dust/list 환불 산식과 독립 (환불은 지불 자산, 수수료는 수령 자산).
- 수취 계정 없음(소각) — ADR 기록.
- `GET /spot/account/commission` → `{ makerBps, takerBps, maker:"0.00100000", taker:"0.00100000" }`.

## 5. exchange-info & 주문 검증

- `GET /spot/market/exchange-info` — **소스는 TickerStatsService meta** (부트 로드 단일 소스; meta에 minNotional 추가 로드):
```json
{ "serverTime":0, "klineIntervals":[...], "orderTypes":[...7종], "timeInForce":["GTC","IOC","FOK"],
  "symbols":[{ "symbol":"BTCUSDT","baseAsset":"BTC","quoteAsset":"USDT","pricePrecision":2,"qtyPrecision":5,
    "tickSize":"0.01","stepSize":"0.00001","minNotional":"5.00000000","ocoAllowed":true }] }
```
- `ocoAllowed`는 플랫폼 상수 true (전 심볼) — 문서화.
- `GET /spot/market/time` → `{serverTime}`.
- OrderService 검증 (모든 placement 경로 공통 함수): price/stopPrice 소수자릿수 <= pricePrecision, qty 소수자릿수 <= qtyPrecision, notional >= minNotional (LIMIT류: price*qty; MARKET BUY: origQuoteQty; MARKET SELL: last*qty 추정 — last 없으면 생략). 위반 400.

## 6. Kline — SQL 단일 소스 (in-memory 캔들 없음)

- 인터벌: `1m,3m,5m,15m,30m,1h,2h,4h,6h,8h,12h,1d,3d,1w,1M` — `domain/kline/intervals.ts` 단일 상수 (exchange-info와 공유).
- 버킷: 고정폭은 `floor(t/w)*w`; `1w`는 월요일 정렬 `floor((t-345600000)/w)*w+345600000`; `1M`은 `date_trunc('month')`. 기준 시각 = `Trade.executedAt`.
- OHLC: 버킷 내 `ORDER BY seq` 첫/끝 (createdAt 동률 안전). SQL은 `$queryRaw` (집계 + window/DISTINCT ON).
- **REST** `GET /spot/market/klines?symbol=&interval=&limit=&endTime?` (limit 기본 500/최대 1000, DefaultValuePipe 명시):
  - 윈도 = `[endTime - limit*w, endTime)` 산술 고정 (1M은 월 단위 산술). endTime 생략 시 now.
  - fill-forward: 윈도 시작 직전 마지막 trade close를 anchor 쿼리로 1회 조회 → 빈 버킷 O=H=L=C=직전close, V=0 채움. 심볼 최초 체결 이전 버킷은 trim.
  - 현재(미완결) 버킷도 같은 SQL로 포함 (Trade는 hot-path 동기 INSERT라 stale 아님).
  - **응답 shape: WS와 동일한 named object** (positional array 금지):
    `{symbol, interval, openTime, closeTime, open, high, low, close, volume, quoteVolume, tradeCount, isFinal}`
    가격 toFixed(pricePrecision), volume toFixed(qtyPrecision), quoteVolume toFixed(pricePrecision) — 기존 Ticker24h 관례.
- **WS** `<sym>@kline_<interval>`: 게이트웨이 1s 타이머 — 구독자 있는 (sym,interval)만 현재 버킷 SQL 재계산 → push. 버킷 롤오버 감지 시 직전 버킷 isFinal=true 1회 push 후 새 버킷 push. 구독 스냅샷 = 현재 버킷 1개 (히스토리는 REST).
- 미지원 인터벌 → REST 400 / WS subscribe 에러(§7).

## 7. WS market 확장 (market.gateway.ts)

| 스트림 | payload | push |
|---|---|---|
| `<sym>@kline_<i>` | §6 named object | 1s 타이머 (구독자 한정) |
| `<sym>@miniTicker` | `{symbol, lastPrice, open, high, low, volume, quoteVolume}` | 1s 스로틀 (trade 발생 심볼만) |
| `!miniTicker@arr` | 위 배열 (데이터 없는 심볼 제외) | 1s 스로틀 |
| `<sym>@bookTicker` | `{symbol, bidPrice, bidQty, askPrice, askQty, lastUpdateId}` (precision 포맷) | DPD 후 best (price,qty) 변경 시만 — **lastUpdateId는 비교에서 제외** |
- miniTicker `open` = `TickerStats`에 `open24h`(=firstPrice24h) 필드 신설해 직접 노출 (문자열 빼기 금지). lastPrice null인 심볼은 miniTicker에서 생략.
- **OrderBookCacheService best 추적을 증분으로**: applyDiff에서 cached best 갱신 (개선 가격 삽입 O(1), best 레벨 삭제 시만 선형 재스캔; 전체 sort 금지). bookTicker 포맷은 ticker precision (toFixed(8) 금지).
- SUBSCRIBE 검증: 파싱 불가/미지원 스트림은 등록하지 않고 `{error:'invalid streams', streams:[...거부 목록], id}` 응답.
- 서버 ping 30s / pong 미응답 종료 (market + user gateway 공통).
- 기존 trade/ticker/depth/!ticker@arr 동작 유지.

### REST market 추가 (모두 공개)
- `GET klines` (§6) / `GET time` / `GET exchange-info` (§5)
- `GET avg-price?symbol=` → `{symbol, window:"5m", avgPrice}` (TickerStats 5분 가중평균; 없으면 lastPrice; 그것도 없으면 404)
- `GET ticker-price?symbol?` → `{symbol, price}` 또는 전체 배열
- `GET ticker?symbol=&windowSize=` — windowSize **필수** (`1h|4h|1d|7d`), 누락 400. Trade SQL 집계 (executedAt 기준)
- `GET agg-trades?symbol=&limit=` — (takerOrderId, price) 그룹: `[{aggId, price, qty, firstTradeId, lastTradeId, ts, isBuyerMaker}]`, `isBuyerMaker = takerSide==='SELL'`
- `GET historical-trades?symbol=&limit=&endTime?` — recent-trades shape + endTime 커서
- `GET depth` 단위 버그 수정 — WS와 동일 precision 포맷 (현재 raw 10^8 string 반환 중)

## 8. User Data Stream

### 8.1 연결/인증
- 게이트웨이 `http/ws/user.gateway.ts`, path `/ws/user` (UserStreamModule에서 제공 — ws.module.ts 수정 금지).
- 인증 (handleConnection의 2번째 인자 IncomingMessage):
  - 쿠키: **`request.headers.cookie`를 직접 파싱** (cookie-parser는 upgrade에 안 돈다 — AuthSessionService.extractToken 재사용 금지) → `bs_session` → `JwtService.verify`. 추가로 Origin 헤더를 CORS_ORIGINS와 대조, 불일치 시 거부.
  - 또는 `?listenKey=` (Origin 검사 생략 — 키 소지가 자격). **upgrade URL 로깅 금지.**
  - 실패 시 close(4401).
- listenKey: `domain/user-stream/listen-key.service.ts` in-memory Map + 만료 스윕. **만료/DELETE 시 해당 키로 연결된 소켓 close(4401)** (gateway가 listenKey→sockets 인덱스 유지).
- REST는 **신설 컨트롤러** `http/rest/spot/user-data-stream/` (ADR-016 account 순수성 유지):
  - `POST /spot/user-data-stream` (PrivateGuard) → `{listenKey}` (TTL 60m) / `PUT` keepalive / `DELETE` 즉시 만료.
- 단일 BE 인스턴스 전제 (in-memory emitter/listenKey) — ADR 기록.
- 소켓 관리: WeakMap<WebSocket,userId> + Map<userId,Set<WebSocket>> (빈 Set 삭제), UserStreamService에 **게이트웨이가 단일 리스너 1개** 등록해 맵으로 라우팅 (연결별 listener 금지 — leak).

### 8.2 이벤트 (UserStreamService — 순수 EventEmitter)
- 메시지 `{stream:'executionReport'|'outboundAccountPosition'|'listStatus', data}`. 연결 시 스냅샷 없음 (REST 초기 로드 + **재연결 시 FE가 REST 재동기화** §10).
- `executionReport`: `{orderId, orderListId?, symbol, side, type, timeInForce, price?, stopPrice?, origQty?, origQuoteQty?, executedQty, cumulativeQuoteQty, status, ts}`
  - **모든 OU 수신마다 발행** (status 무변경 P 반복 포함). eq/cqq는 **OU 메시지 값** (DB 금지).
  - placement 직후(NEW, DB 저장 후 Kafka emit 전 — feedback-004 응답과 일관), 트리거 arming 후, BE 로컬 취소 후에도 발행.
  - 가격/수량은 ticker precision display string.
- `outboundAccountPosition`: `{balances:[{asset, free, locked, ts}]}`
  - **잔고는 쓰기 트랜잭션 안에서 캡처** (tx.wallet.update 반환값 수집; 사후 SELECT 금지 — 순서 역전). placement lock 경로 + settlement worker 경로 모두. ts = wallet.updatedAt (FE가 자산별 max(ts)로 stale drop).
  - worker는 batch 적용 후 (userId,asset)별 최신값만 emit.
- `listStatus`: `{orderListId, symbol, status, orders:[{orderId, status}], ts}` — 리스트 전이 시.

## 9. REST 확장 — 보안타입 표기 (canTrade 강제는 기존대로 미구현 — ADR-019 시퀀싱 유지, 문서만)

### trading (PrivateGuard, TRADE)
- `POST /orders` — 새 타입 수용 (stopPrice 등). **선택 필드 `replacesOrderId`** (cancel-replace 대체):
  - 시퀀스: 기존 주문 검증(본인, 비terminal, **OCO 레그 아님**, 같은 심볼) → **신규 주문 placement 먼저** (잠금+NEW row+emit) → 기존 주문 CO emit → 응답 `{order, replaced:{orderId, cancelRequested:true}}`.
  - 비원자성 명시: 양쪽 잠금이 잠시 공존 (신규 잠금은 즉시, 기존 환불은 비동기). 기존 주문이 CO 도달 전 체결될 수 있음 — Binance와 다른 단순화, ADR 기록. PUT 엔드포인트는 만들지 않는다.
- `DELETE /orders/:id` — 미트리거 stop은 §2.4 guarded 로컬 취소(즉시 CANCELED 반환); OCO 레그면 리스트 취소로 라우팅; 그 외 CO (terminal 전체 거부).
- `DELETE /open-orders?symbol=` — **symbol 필수** (누락 400). 본인 open 주문 일괄: 엔진 거주 → CO, BE 보관 stop → 로컬 취소, OCO → 리스트 취소. 응답: 대상 주문 배열.
- `POST /order-lists`, `DELETE /order-lists/:id` (§3)

### account (PrivateGuard, USER_DATA — read 전용, Prisma만)
- `GET /open-orders?symbol?` — NEW/OPEN/PARTIAL + 심볼 필터. **기존 `GET /orders?open=true`의 open 파라미터는 제거** (중복 표면 금지; FE 전면 재작성이라 호환 부담 없음).
- `GET /orders?symbol?&limit=&endTime?` — 이력, limit 기본 100/최대 500 (DefaultValuePipe).
- `GET /trades?symbol?&limit=&endTime?` — **명시적 select** (상대방 정보 노출 금지): `{id, orderId, symbol, market, price, qty, quoteQty, commission, commissionAsset, isBuyer, isMaker, time}` — 본인이 maker/taker인지에 따라 본인 측 commission만.
- `GET /order-lists?limit=`
- `GET /commission` (§4)

## 10. FE 구현

### 10.1 lib 계층 (정확한 파일/export 계약 — 에이전트 간 병렬 작업 기준)
- `lib/types/market.ts` 확장: `Kline`(§6 named object), `MiniTicker`, `BookTicker`, `ExchangeInfo`, `SymbolInfo`, `Ticker24h`에 `open24h` 추가.
- `lib/types/trading.ts` 신설: `Order`, `OrderList`, `MyTrade`, `Balance{asset,free,locked,ts?}`, `OrderType`, `OrderStatus`, `TimeInForce`, `CreateOrderReq`(replacesOrderId? 포함), `CreateOcoReq`, `ExecutionReport`, `AccountPosition`, `ListStatusEvent` — BE shape 그대로 (Decimal→string).
- `lib/api/market.ts`: `fetchExchangeInfo()`, `fetchKlines(symbol, interval, limit, endTime?)`.
- `lib/api/trading.ts`: `createOrder`, `cancelOrder(id)`, `cancelAllOrders(symbol)`, `createOco`, `cancelOco(id)`.
- `lib/api/account.ts`: `fetchBalances`, `fetchOpenOrders(symbol?)`, `fetchOrders(params)`, `fetchMyTrades(params)`, `fetchOrderLists`, `fetchCommission`.
- `lib/ws/client.ts` 확장: `onReconnect(cb)` 훅 추가 + 서버 `{error, streams, id}` 수신 시 해당 스트림 subs 제거·리스너에 에러 전파.
- `lib/ws/user-client.ts` 신설: `/ws/user` 싱글톤, 로그인 상태에서만 연결, 이벤트 타입별 listener, 재연결 백오프, **onOpen(재연결 포함) 콜백** 노출.
- `lib/hooks/use-market.ts` 확장: `useKlines(symbol, interval)` — REST 초기 + `@kline_` 머지, **재연결 시 REST 재조회**; `useBookTicker`, `useExchangeInfo`(react-query, staleTime 1h).
- `lib/hooks/use-trading.ts` 신설: `useOpenOrders(symbol?)`, `useOrderHistory`, `useMyTrades`, `useBalances`, `useOrderLists` — executionReport/outboundAccountPosition/listStatus로 캐시 갱신 (balances는 자산별 ts 비교로 stale drop), **user-ws (재)연결 시 `['spot',...]` 키 invalidate**; mutations `useCreateOrder`/`useCancelOrder`/`useCancelAll`/`useCreateOco`/`useCancelOco`.
- query key: `['spot','openOrders',symbol??'all']`, `['spot','orders',...]`, `['spot','trades',...]`, `['spot','balances']`, `['spot','orderLists']`, `['spot','exchangeInfo']`.

### 10.2 차트 — lightweight-charts **v5.2 설치됨** (v4와 API 다름: `chart.addSeries(CandlestickSeries, opts)` — node_modules 타입 선언 확인 후 작성)
- `components/trade/chart-panel.tsx` 재구현: candlestick + volume histogram, 인터벌 버튼은 `useExchangeInfo().klineIntervals` (하드코딩 금지), useKlines 라이브 머지, 심볼/인터벌 변경 시 데이터 리셋, ResizeObserver, 색은 디자인 토큰 (#0ecb81/#f6465d, 배경 투명, 그리드 #2b3139 계열).
- 죽은 UI(Info/Data 탭, Indicators) 제거.

### 10.3 주문 폼 (전면 재구현, client component, props {symbol})
- exchange-info에서 심볼 메타/주문타입/minNotional. 탭: Limit / Market / Stop-Limit / Stop-Market / OCO (orderTypes 기반 구성; Post-Only는 Limit 탭 체크박스 → type POST_ONLY).
- Buy/Sell 토글, Price/Stop/Qty/Total (Total⇄Qty 환산; MARKET·STOP-MARKET BUY는 Total=origQuoteQty 입력), 25/50/75/100% (가용잔고), Avail (useBalances), Est. fee (commission 요율), TIF (limit류만), 클라 검증(precision/minNotional) + 서버 에러 인라인 표시, 성공 시 리셋.
- 미로그인: Log In / Sign Up 링크. Cross/Isolated 토글 제거 (spot에 없음).
- 라벨 'Qty' (Amount 금지).

### 10.4 PositionsPanel 실데이터
- 탭 Open Orders(n) / Order History / Trade History / Assets — 실카운트·실데이터, 'Hide other pairs' 동작, 행별 Cancel, Cancel All(현재 심볼), stop 트리거 조건 표시, OCO 그룹 표시(listId), 라이브 갱신.

### 10.5 페이지
- `/orders`·`/orders/history`·`/orders/trades`: 실데이터 + 필터(심볼/side) + 취소 + 더보기(endTime 커서) + 라이브 갱신.
- `/wallet`: useBalances + USDT 환산(tickers lastPrice), 0 잔고 숨김 토글. Deposit/Withdraw는 disabled 유지 (범위 외).
- `/portfolio`: 총 자산(USDT), SVG 도넛(외부 라이브러리 금지), 자산 테이블. Equity curve 패널 제거 (스냅샷 인프라 부재 — 보고서 기록).
- `symbol-header.tsx`: 페어 셀렉터 드롭다운 (tickers 검색→라우팅). '≈$'는 quote USDT/USDC일 때만.
- `asset-table.tsx`: 하드코딩 제거 → useBalances.
- `market-table.tsx`: 빈 결과 시 'No results' (Loading과 구분).

### 10.6 FE 규칙
- Next 16.2.2 문서 확인. 'use client' 최소화. 영어 전용. BE 문자열 재포맷 금지(정렬용 Number()만). tnum. 도메인 목록 하드코딩 금지. 새 라이브러리 설치 금지(lightweight-charts 기설치 외). 토스트 라이브러리 없음 — 인라인 표시.
- 쿠키 인증 전제: FE/BE 동일 registrable domain (dev: localhost 포트 차이는 same-site OK) — ADR 기록.

## 11. 범위 제외 (보고서 명시)
- STP(사용자 제외 지시) / ICEBERG(엔진 수정 필요) / trailingDelta(후속) / WS aggTrade(가치 낮음, REST만) / 입출금 / Equity curve / cancelReplace 원자 모드(엔진 cancel-ack 부재 — replacesOrderId 단순화로 대체).

## 12. 검증
- BE: `npx prisma generate` → `npm run build` + `npm run lint` + `npm test`.
- FE: `npm run build` + `npm run lint`.
- 마이그레이션: 사용자 실행 `npx prisma migrate dev --name binance_spot_features`.
