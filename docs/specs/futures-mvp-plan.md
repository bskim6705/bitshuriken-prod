# Futures MVP 구현 계획 (핸드오프 문서)

> **상태: 구현 완료 (2026-06-10).** Stage 1~7 전부 완료 — BE 빌드/린트/jest 107, 엔진 pytest 18, FE 빌드/린트 그린. 적대적 검증 2회(Stage 4: critical 1·major 5 수정 / Stage 5+6: critical 2·major 4 수정). 라이브 e2e 검증은 유저 수행 대기 — §14 참조.
> 알려진 부채: 청산 NO의 create↔emit 비원자(완화 적용, 근본 해결은 dispatchedAt 컬럼 필요), futures 주문 제출 시점 executionReport 미발행(첫 리포트는 엔진 OU), fmarket kline 스트림 없음(FE 차트 5s REST 폴링), FE DEFAULT_LEVERAGE=10이 BE Position 기본값 미러, 펀딩 시각에 mark 미정의면 해당 회차 skip(소급 없음), 엔진 재시작 시 open orders 소실(spot과 동일한 기존 운영 리스크).

> 2026-06-10 작성. USDT-margined 무기한 선물 MVP의 단일 진실 소스.
> 구현 에이전트는 **이 문서 + 해당 ADR(027~033)** 을 먼저 읽는다. 코드 사실(파일 경로·시그니처)은 변했을 수 있으니 편집 전 직접 확인한다.
> 라이브 e2e 검증/테스트는 유저가 직접 수행한다. 에이전트의 완료 기준 = 빌드·타입체크·린트 그린 + 명시된 단위 테스트.

## 0. 확정 정책 (유저 결정, 변경 금지)

| 정책 | 결정 |
|---|---|
| 마진/포지션 | **Isolated 전용, one-way** (cross·헤지 모드 없음) |
| 마크 프라이스 | **자체 spot 시장 인덱스** (외부 오라클 없음) |
| 청산 | BE 모니터(트리거 패턴) + 엔진 무수정 + 일반 IOC MARKET 발행, 전량 청산, **잔여 결손은 보험기금 인수** |
| 펀딩 | **8h + premium 산식** (UTC 00/08/16, 주기는 코드 상수) |
| 배포 | 단일 NestJS 앱 + ENV 조건부 조립(ADR-018 S3). 별도 앱/모노레포 아님 |

MVP 제외: cross 마진, 헤지 모드, 레버리지 브래킷(단일 MMR), 선물 STOP/TP(후속 — 트리거 인프라는 있음), ADL, 부분 청산, multi-asset, K-line 신규 구현(기존 SQL 재사용).

## 1. 코드 분리 규칙 (ADR-027)

```
bitshuriken-v2-be/src/
  futures/                      ← futures 전부. 미래의 별도 앱. 이 폴더 밖에 futures 로직 금지
    futures.module.ts           ← 단일 barrel
    http/
      trading/ account/ market/ ← /futures/* REST
      transfers/                ← POST /account/transfers (cross-product 경로, futures 프로세스가 호스팅)
      ws/                       ← /ws/fmarket, /ws/fuser
    consumer/                   ← match.futures.{out,book} 소비 + match.spot.out TR read-only(인덱스용)
    settlement/                 ← futures 전용 worker (포지션 상태기계)
    position/ margin/ mark-price/ funding/ liquidation/ config/
```

**import 경계 (eslint `no-restricted-imports`/`import/no-restricted-paths`로 강제)**
- `src/futures/**` → 허용: `infra/**`, `shared/**`, `domain/{auth,user,wallet,ticker,orderbook}` (+ `domain/kline`은 market 파라미터화 확인 후)
- `src/futures/**` → 금지: `domain/{order,trade,settlement,trigger,order-list,user-stream}` (spot 소유)
- 역방향: spot/공유 코드는 `src/futures/**` import 금지 (app.module 조건부 import만 예외)

**ENV 조건부 조립**: `MARKETS_ENABLED`(예: `spot,futures`) 필수 env — 없으면 throw.
spot 묶음 = SpotHttpModule + MatchResultModule + MarketDataModule + WsModule(+trigger/user-stream은 도메인 모듈 의존 따라가도록 확인). futures 묶음 = FuturesModule.
Kafka consumer groupId = `bitshuriken-be-` + markets join (예: `bitshuriken-be-spot`, `bitshuriken-be-spot-futures`).

**spot/공유 파일 수정 허용 목록 (이외 수정 금지)**
1. `src/domain/settlement/settlement.worker.ts` — kind 필터(`kind IN (TRADE, DUST_REFUND)`) + 미지의 leg 타입 throw
2. `src/infra/messaging/match-result.controller.ts`(+module) — `match.futures.out` 핸들러 제거
3. `src/infra/messaging/market-data.controller.ts` — `match.futures.book` 핸들링 제거 (futures consumer가 자체 처리)
4. `src/http/rest/spot/**` — `tickerMarket=SPOT` 강제 (보안 구멍: 현재 FUTURES가 통과됨)
5. `src/app.module.ts`, `src/main.ts` — 조건부 조립 + groupId
6. `eslint.config.mjs` — 경계 규칙 추가
7. `prisma/schema.prisma`, `prisma/seed.ts` — additive 변경만
8. `docker-compose.yml`, `bitshuriken-v2-match/config/*` — 엔진 인스턴스 분리
9. FE: `lib/ws/client.ts`(또는 상응 파일) path 파라미터화, 네비게이션에 futures 링크

**매칭엔진**: 코드 공유, 인스턴스 분리. `config/tickers.json` → `tickers-spot.json`/`tickers-futures.json` 분리, docker-compose 또는 실행 스크립트에 futures 인스턴스 추가(`MATCH_CONFIG_PATH`). 엔진 코드 변경은 §5의 1건뿐.

## 2. 데이터 모델 (Prisma — additive만)

```prisma
enum PositionStatus { NORMAL LIQUIDATING }

model Position {
  userId         String
  tickerSymbol   String
  tickerMarket   MarketType  // 항상 FUTURES (Ticker FK용)
  qty            Decimal @default(0) @db.Decimal(32, 8)  // signed: +롱 −숏
  entryPrice     Decimal @default(0) @db.Decimal(32, 8)
  isolatedMargin Decimal @default(0) @db.Decimal(32, 8)
  leverage       Int     @default(10)
  status         PositionStatus @default(NORMAL)
  updatedAt      DateTime @updatedAt
  // FK → User, Ticker. @@id([userId, tickerSymbol])
}

model FuturesConfig {           // Ticker(FUTURES) 1:1. 도메인 데이터는 DB (feedback-015)
  tickerSymbol        String  @id
  maxLeverage         Int
  mmr                 Decimal @db.Decimal(10, 8)  // maintenance margin rate, 예 0.005
  liquidationFeeRate  Decimal @db.Decimal(10, 8)
  maxNotional         Decimal @db.Decimal(32, 8)  // 포지션+미체결 합산 상한
  fundingCap          Decimal @db.Decimal(10, 8)  // 예 0.003
  priceBandPct        Decimal @db.Decimal(10, 8)  // LIMIT 주문가 허용폭, 예 0.05
  marketCostBufferPct Decimal @db.Decimal(10, 8)  // MARKET 가정가 버퍼, 예 0.005
  markClampPct        Decimal @db.Decimal(10, 8)  // mark = index ± clamp, 예 0.005
}
// 로드 시 invariant 검증(위반 시 throw): 1/maxLeverage > mmr + liquidationFeeRate
// minNotional은 Ticker.minNotional 재사용. 주기/이자율은 코드 상수(8h, 0.01%/8h) — DB 필드 금지

model FundingRate {  // id, tickerSymbol, fundingTime, rate, markPrice, @@unique([tickerSymbol, fundingTime])
}

enum FuturesIncomeType { REALIZED_PNL COMMISSION FUNDING_FEE LIQUIDATION_FEE TRANSFER INSURANCE_CLEAR }
model FuturesIncome {  // 조회용 원장. worker apply 트랜잭션에서 insert
  // id, userId, tickerSymbol?, incomeType, income Decimal(32,8) signed, sourceKey @unique, createdAt
  // @@index([userId, createdAt])
}
```

기존 모델: `Order`에 `reduceOnly Boolean @default(false)`, `liquidation Boolean @default(false)`, `lockedCost Decimal? @db.Decimal(32,8)` 추가. `SettlementKind`에 `FUTURES_TRADE, FUTURES_REFUND, FUNDING, LIQUIDATION_TAKEOVER` 추가. Wallet/Trade 무변경 (futures 수수료는 Trade.maker/takerCommission에 USDT로 기록).

**보험기금**: seed로 시스템 유저(email 코드 상수, 예 `insurance-fund@bitshuriken.internal`) + FUTURES USDT wallet 생성. 코드에서 email로 1회 조회 캐시, 없으면 throw.

**seed 값** (futures BTCUSDT/ETHUSDT, 조정 가능): maxLeverage 50, mmr 0.005, liquidationFeeRate 0.005, maxNotional 1000000, fundingCap 0.003, priceBandPct 0.05, marketCostBufferPct 0.005, markClampPct 0.005. futures Ticker row(엔진 config와 동일 precision: BTC p1/q3, ETH p2/q3) + minNotional 5.

## 3. 산식 (전부 Prisma Decimal 연산, 8dp. 유저에게 유리한 방향 금지: 지급=floor, 차감=ceil, dust는 보험기금 귀속)

표기: qty는 signed(+롱/−숏), Q=|qty|, m=mark, p=체결가/주문가, lev=leverage.

- notional = p × Q (USDT)
- **IM** = notional / lev
- **openLoss** (LIMIT): BUY `max(0, p − m) × q`... 정확히: BUY `(p − m > 0 ? (p−m)×qty : 0)`, SELL `(m − p > 0 ? (m−p)×qty : 0)`
- **MARKET 가정가**: BUY `ap = m × (1 + marketCostBufferPct)`, SELL `ap = m × (1 − marketCostBufferPct)` — notional·IM·openLoss를 ap 기준으로
- **주문 cost(lockedCost)** = IM + openLoss + notional × takerBps/10000 (수수료 예약). reduceOnly·liquidation 주문은 lockedCost = 0 (잠금 없음)
- **가격 밴드**: LIMIT p가 `[m×(1−priceBandPct), m×(1+priceBandPct)]` 밖이면 400 거부
- **UPNL** = (m − EP) × qty (signed라 롱/숏 모두 성립)
- **MM** = mmr × m × Q
- **marginRatio** = MM / (isolatedMargin + UPNL). 분모 ≤ 0이면 즉시 청산 대상
- **청산가**: 롱 `LP = (EP×Q − margin) / (Q × (1 − mmr))`, 숏 `LP = (EP×Q + margin) / (Q × (1 + mmr))`
- **파산가**: 롱 `BP = EP − margin/Q`, 숏 `BP = EP + margin/Q`
- **EP 가중평균(증량)**: `newEP = (Q×EP + fillQty×p) / (Q + fillQty)` floor 8dp
- **RPNL(감량)**: `(p − EP) × closeQty × sign(qty)`
- **펀딩**: premium 1분 샘플 `P = (m − index)/index`, 정산 시 `F = avgP + clamp(0.01% − avgP, ±0.05%)` 후 `clamp(F, ±fundingCap)`. 지급액 = `−F × m × qty` (signed: F>0이면 롱 음수=지불, 숏 양수=수령 → zero-sum). 샘플 0개면 `F = clamp(0.01%, ±cap)`

## 4. Kafka 컨트랙트 — 무변경

토픽 `match.futures.{in|out|book}` 기존. op NO/CO/TR/OU/DPD 그대로, 필드 추가 없음. reduceOnly/liquidation은 엔진이 모름(BE 책임). **선물 MARKET BUY는 base-driven**: `oq` 채우고 `oqq="0"` (선물에서 origQuoteQty 미사용). 청산 주문도 일반 NO(IOC MARKET).

## 5. 매칭엔진 (유일한 코드 변경 + pytest)

`engine/order.py`의 `is_quote_driven`: 현재 `MARKET and BUY` → `MARKET and BUY and orig_quote_qty > 0` 로 수정 (spot 불변 — spot MARKET BUY는 항상 oqq 발행. `matcher.py`의 quote-driven 분기가 이 속성만 참조하는지 확인). pytest 신설: base-driven MARKET BUY 매칭, quote-driven 기존 동작 회귀, IOC 잔여 종결(EXPIRED — ADR-026), POST_ONLY 거부, 부분체결 FIFO 등 ~10케이스. requirements에 pytest 추가.

## 6. 정산 상태기계 (ADR-032 — 가장 중요한 명세)

**원칙: consume 시점에는 raw 체결 사실만 저장, 포지션 의존 계산(EP/RPNL/마진)은 worker apply 시점에 Position 행을 잠그고 순서대로.** (multi-fill에서 stale EP로 계산하면 전부 틀림)

### consume (`futures-match-result.controller` — `match.futures.out`)
- **TR**: Trade insert(commission = notional×bps, asset USDT) + SettlementEvent append(kind=FUTURES_TRADE, sourceKey=tradeId, legs=raw: {symbol, price, qty, makerOrderId/UserId, takerOrderId/UserId, takerSide, makerFeeBps, takerFeeBps}) 한 트랜잭션. P2002 swallow(멱등). TickerStats.applyTrade 호출(스탯/@ticker 유지).
- **OU**: order status 동기 update(spot과 동일). terminal(F/C/R/E)이고 lockedCost > 0이면 FUTURES_REFUND append: {orderId, userId, finalExecutedQty(메시지 eq)}.
- **DPD**(`match.futures.book`, futures consumer가 자체 소비): OrderBookCache(FUTURES/sym) 적용 + fmarket gateway fanout.

### apply (`futures-settlement.worker` — @Interval(100), kind IN futures 4종, createdAt 순 직렬 처리)
FUTURES_TRADE — maker/taker 각각에 대해 (Position 행 SELECT FOR UPDATE):
- fillDelta = side가 BUY면 +q, SELL이면 −q
- **증량** (qty==0 또는 같은 부호): EP 가중평균 갱신; marginAdd = p×q/lev; fee = p×q×bps(ceil); lockedRelease = lockedCost×q/origQty(floor, reduceOnly/liquidation은 0); wallet: locked −= lockedRelease, balance += lockedRelease − marginAdd − fee; isolatedMargin += marginAdd. 부족분은 balance 음수 허용 + error 로그(fail loudly)
- **감량** (반대 부호): closeQty c = min(q, Q); RPNL; marginRelease = isolatedMargin×c/Q(floor); fee = p×c×bps(ceil); balance += marginRelease + RPNL − fee; isolatedMargin −= marginRelease; lockedRelease 동일 규칙(감량 체결분도 환불 — 고착 금지); **liquidation 주문이면 추가로 liqFee = p×c×liquidationFeeRate를 balance에서 차감해 보험기금 balance에 적립(income LIQUIDATION_FEE)**
- **flip(초과 e = q − c > 0)**: 전량 close 후 새 포지션 qty=±e, EP=p. IM은 잔여 lockedRelease에서, 부족분 balance에서. balance 부족 시 신규분을 보험기금이 p로 즉시 인수(LIQUIDATION_TAKEOVER leg) + error 로그
- Order executedQty/cumulativeQuoteQty 갱신(orderLegs), FuturesIncome(REALIZED_PNL, COMMISSION) insert — 전부 같은 트랜잭션
- apply 후: 해당 user+symbol의 reduceOnly open 주문 합계 > Q면 초과분 CO 발행. 포지션/잔고 이벤트를 fuser stream으로 emit

FUTURES_REFUND: refund = lockedCost × (origQty − eq)/origQty (floor); locked −= refund, balance += refund.
FUNDING: payment = −F×m×qty (floor 지급/ceil 차감); balance에서, 부족분 isolatedMargin에서 차감 후 marginRatio 재평가 플래그. income FUNDING_FEE.
LIQUIDATION_TAKEOVER: 유저 Position(qty r, margin mg) → qty 0/margin 0; 보험기금 Position에 r을 BP 기준 EP 가중평균으로 합산; mg는 보험기금 balance로. income INSURANCE_CLEAR. **invariant: 심볼별 sum(Position.qty) == 0 유지.**

## 7. MarkPriceService (ADR-029)

- 자체 kafkajs consumer(groupId `bitshuriken-futures-index`)로 `match.spot.out` 구독, op=TR만 파싱 → `index[sym] = EMA30s(price)`. spot 체결 없으면 index 동결(staleness 정지 없음 — 폐쇄계 정책)
- futures mid = OrderBookCache(FUTURES) best bid/ask 중간값. `mark = index + clamp(EMA30s(mid − index), ±index×markClampPct)`. mid 부재 → mark = index. index 부재(부팅 직후 spot 체결 0건) → mark 없음: 주문 접수/청산/펀딩에서 `getMark()` throw (fail loudly)
- 1s tick으로 계산·캐시·EventEmitter emit. 연산은 Decimal, floor 8dp. 1분마다 premium 샘플을 FundingScheduler에 적립

## 8. 청산 (ADR-031)

LiquidationMonitor (futures 프로세스 전용, mark tick 구동, 캐시 없이 DB 조회):
1. `qty != 0 AND status = NORMAL` 포지션 조회, marginRatio ≥ 1 (또는 분모 ≤ 0) 판정
2. guarded claim: `updateMany(where: {userId, tickerSymbol, status: NORMAL}, data: {status: LIQUIDATING})` — 1건 갱신 실패 시 skip (중복 방지)
3. LIQUIDATING 동안: 해당 user+symbol 신규 주문·positions PATCH 거부, 해당 유저 futures→spot transfer 거부
4. 해당 user+symbol open 주문 전부 CO 발행 → Order rows가 전부 terminal 될 때까지 poll(타임아웃 시 error 로그 + 중단·재시도)
5. 잔여 Position.qty로 IOC MARKET NO 발행 (liquidation=true, lockedCost=0, 유저 명의 — feedback-002 준수)
6. OU terminal + 정산 apply 후 qty 잔존 시 LIQUIDATION_TAKEOVER append → status NORMAL 복귀(qty 0)
보험기금 포지션은 모니터 제외(fund userId 비교), 펀딩 포함, 정리는 수동 운영.

## 9. 펀딩 (ADR-030)

FundingScheduler (futures 프로세스 전용): 1분 @Cron premium 샘플(심볼별 in-memory ring, 재시작 시 부분 윈도우 허용·문서화). `@Cron('0 0 0,8,16 * * *', { timeZone: 'UTC' })` 정산: rate 산출 → FundingRate insert → 스냅샷(qty≠0 전부, LIQUIDATING 포함 — zero-sum) → 유저별 FUNDING event(sourceKey `funding:{sym}:{ts}:{userId}`) append. 라운딩 dust는 보험기금 leg로.

## 10. REST / WS (ADR-033)

```
POST   /futures/trading/orders            {symbol, type(LIMIT|MARKET|POST_ONLY), side, timeInForce?, price?, qty, reduceOnly?}
DELETE /futures/trading/orders/:id
PATCH  /futures/trading/positions/:symbol {leverage} XOR {marginDelta}
GET    /futures/account/balances | positions | orders | trades | income
GET    /futures/market/tickers | depth | recent-trades | book-ticker | klines | mark-price | funding-rate
POST   /account/transfers                 {fromMarket, toMarket, assetSymbol, qty}
```
- 주문 접수 검증 순서: ticker/config 로드 → LIQUIDATING 거부 → 밴드(LIMIT)/mark 존재 → Ticker.minNotional → maxNotional(포지션+open 합산) → reduceOnly면 Σ(reduceOnly open qty)+qty ≤ Q 검증(잠금 없음) → 아니면 cost 계산·동기 잠금(balance→locked, Order.lockedCost 기록) → NO 발행 → NEW 반환 (feedback-004)
- leverage 변경: qty==0일 때만. marginDelta: + 는 balance→isolatedMargin(가용 검증), − 는 잔여 margin ≥ mark notional/lev 검증
- transfers: 동기 트랜잭션, 수신측 wallet upsert, futures-out은 PENDING futures 이벤트 존재·LIQUIDATING 포지션 존재 시 거부. FuturesIncome(TRANSFER) 기록
- WS `/ws/fmarket`: `{sym}@depth|trade|ticker`, `!ticker@arr`, `{sym}@markPrice`(mark/index/lastFundingRate/nextFundingTime, 1s) — 기존 gateway 패턴 복제
- WS `/ws/fuser`: user-stream 패턴 복제(쿠키+listenKey), 이벤트: 주문 업데이트·포지션 업데이트·잔고 업데이트(청산 통지 포함)

## 11. FE (Stage 7)

- `lib/api/futures.ts`, `lib/types/futures.ts`, 훅(`use-futures-*`). 기존 spot 패턴 복제. 수량 필드 qty, 숫자 string
- `app/futures/[symbol]/page.tsx`: spot trade 페이지 grid 복제, fmarket 스트림 연결
- 주문 폼 futures variant: Leverage 다이얼로그(1~maxLeverage, API에서), "Isolated" 라벨(토글 아님), Limit/Market 탭, Reduce-Only 체크박스, Cost/Available, Buy/Long·Sell/Short
- Positions 패널: size/entry/mark/liq.price/margin/PnL(ROE)/Close(=reduceOnly MARKET). fuser 스트림 구동 + REST 초기 로드
- SymbolHeader futures variant: Mark/Index/Funding rate+카운트다운. Wallet에 Futures 탭 + Transfer 모달. UI 영어 전용 (feedback-012)

## 12. 단계와 완료 기준

| Stage | 내용 | 완료 기준 (에이전트) |
|---|---|---|
| 1 | 스키마+seed, spot SPOT 강제, worker kind 필터, match-result futures 제거, transfers | `npx prisma generate` + `npm run build` 그린. **마이그레이션 실행 금지** (유저가 `npx prisma migrate dev`) |
| 2 | 엔진 is_quote_driven + pytest, config 분리, compose | `pytest` 그린 |
| 3 | MarkPrice + /futures/market/* + /ws/fmarket | build 그린, 모듈 단위 wiring |
| 4 | 주문 접수 + consumer + 정산 worker + /futures/trading·account | build 그린 + 정산 단위테스트(아래) |
| 5 | FundingScheduler | build 그린 |
| 6 | LiquidationMonitor + 기금 + /ws/fuser | build 그린 |
| 7 | FE 전체 | `npm run build` + lint 그린 |
| 8 | 전체 그린 + 유저 검증 가이드 | 3개 레포 빌드/린트/테스트 그린 |

**Stage 4 단위테스트 (구현 전 작성 — 핵심 가드레일)**: 정산 상태기계를 DB mock/test DB로 검증 — multi-fill EP 가중평균, 부분 close RPNL+마진 비례 해제, close 왕복 후 locked==0, flip 초과분 처리, refund 산식, 심볼별 sum(qty)==0, FUNDING zero-sum(라운딩 dust 포함).

## 13. 컨벤션 체크리스트 (전 에이전트 공통)

- 수량 필드 `qty` (amount 금지). BE 내부 Decimal, Kafka는 ×10^8 정수 string, floor
- 주문 mutation은 매칭엔진 경유 (feedback-002). 예외는 ADR에 명시된 것만
- 임의 디폴트 금지(feedback-005), 미래 대비 코드 금지(008), fail loudly — 빈 catch 금지(014), 도메인 데이터는 DB(015)
- 주석은 핵심만 short·self-contained(009), ADR 번호를 코드 주석에 박지 않기
- REST: 동사 경로 금지(003), 주문 제출은 PENDING/NEW 반환(004), 거래소 UX 컨벤션(010), UI 영어(012)
- env는 deployment-variant만(013): MARKETS_ENABLED OK, 정책값은 코드/DB
- `if (marketType === FUTURES)` 분기를 컨트롤러/서비스에 넣지 않기 — 폴더로 분리 (ADR-018)
- Prisma: schema.prisma만 수정, migrations/ 생성·수정 금지, migrate 명령 실행 금지

## 14. 유저 검증 가이드 (전체 완료 후)

1. `.env`에 `MARKETS_ENABLED=spot,futures` 추가 (BE)
2. `cd bitshuriken-v2-be && npx prisma migrate dev --name futures_mvp && npx prisma db seed` (spot 미적용분 binance_spot_features와 합쳐질 수 있음)
3. Kafka 기동 → 엔진 2개(spot/futures config) → BE → FE
4. 시나리오: spot 체결로 index 형성 → transfer로 futures 입금 → 두 계정 롱/숏 교차 → 포지션/EP/UPNL 확인 → reduceOnly close 왕복(locked==0) → 펀딩 강제 트리거 → 고레버리지 청산 시나리오 → `sum(Position.qty)==0` 쿼리
