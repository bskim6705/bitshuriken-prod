# ADR-043: API key 권한(read/trade) enforcement, funding 원장, account/wallet UI 완성

## Status
Accepted

## Context

ADR-019에서 API key의 `canRead`/`canTrade`를 schema에만 두고 enforcement는 후속으로 미뤘다. 그 결과:

- 모든 API key가 사실상 full 권한 — `canTrade=false` 키로도 주문/이체가 가능. 권한 토글이 장식.
- FE의 API key 관리 페이지는 비활성 placeholder (생성/조회/삭제 미연동). BE 엔드포인트(`/auth/api-keys`)는 이미 완성돼 있었음.
- account 프로필/보안 페이지는 정적 "—" placeholder, `/account/preferences`는 404 dead link.
- 입금/출금/내부이체에 감사 기록이 없음. transfer는 `FuturesIncome(type=TRANSFER)` 한 면만 남고, deposit/withdraw는 wallet 잔고만 바꾸고 기록을 안 남김 → "거래 내역" 화면을 만들 소스가 없음.

## Decision

### 1. API key 권한 enforcement (read/trade 2-scope)

ADR-019의 security type(`USER_DATA`/`TRADE`)을 실제 가드에서 강제한다.

- `@RequireApiScope(ApiScope.TRADE)` 데코레이터 (`libs/shared/src/decorators/api-scope.decorator.ts`). 미지정 endpoint는 `READ`로 간주.
- `ApiKeyOnlyGuard`가 `Reflector`로 endpoint 요구 scope를 읽어, signature 검증 후 `record.canTrade`/`canRead`를 확인. 부족하면 403 (`API_KEY_NO_TRADE_PERMISSION`/`API_KEY_NO_READ_PERMISSION`).
- **JWT(웹 세션)는 scope 무관 전체 허용** — 범위는 API key 경로에서만 의미. 웹 UI 동작 불변.
- TRADE로 표기한 대상: spot/futures `trading` 컨트롤러 전체(주문·취소·포지션), portal `transfers`/`funding`(자금 이동). 나머지 private 조회는 기본 READ.
  - withdraw 전용 scope는 도입하지 않음(2-scope 유지). 자금 이동은 TRADE로 묶어, 기본값 `canTrade=false` 키는 이체/출금 불가 — 안전한 기본.

### 2. Funding 원장 (`FundingTx`)

오더북 외 잔고 이동(입금/출금/내부이체)을 단일 원장에 기록한다.

```prisma
enum FundingTxType { DEPOSIT WITHDRAWAL TRANSFER }

model FundingTx {
  id          String        @id @default(uuid())
  userId      String
  type        FundingTxType
  assetSymbol String
  qty         Decimal       @db.Decimal(32, 8)
  fromMarket  MarketType?   // TRANSFER 출발; 입출금은 null
  toMarket    MarketType?   // TRANSFER 도착; 입출금은 영향 마켓(SPOT)
  status      String        @default("COMPLETED")
  createdAt   DateTime      @default(now())
  user        User          @relation(fields: [userId], references: [id])
  @@index([userId, createdAt])
}
```

- `deposit`/`withdraw`는 wallet 변경과 원장 기록을 한 `$transaction`으로 묶음(둘 중 하나만 남는 상태 차단). 반환 id는 `FundingTx.id`.
- `transfer`는 기존 트랜잭션 안에서 `FundingTx`를 만들고 그 id를 `transferId` 및 `FuturesIncome.sourceKey`로 사용.
- 조회: `GET /account/transactions` (portal, 기본 READ scope) — `type`/`asset`/`limit`/`endTime`(epoch ms cursor) 필터, newest-first, 사람이 보는 값은 fixed-8 + `time`은 epoch ms.

### 3. Account/Wallet UI

- **API 관리**: 생성(label + read/trade 토글) → secret 1회 노출(copy + 경고) → 목록(권한 배지/last-used) → revoke(확인). 기존 BE 엔드포인트에 연동.
- **프로필**: 실제 email/userId/가입일 + 수수료 tier 표시. KYC/VIP/2FA 등은 "not available"로 정직하게 deferred.
- **Preferences**: `/account/preferences` 신설(404 해소) — localStorage 기반 client-side 설정.
- **Wallet History**: 지갑에 "History" 탭 추가 — `GET /account/transactions` 연동, type 필터 + load-more.

## Rationale

- 2-scope(read/trade)는 ADR-019가 정의한 모델 그대로. withdraw scope/ IP whitelist/ expiry는 명시적으로 범위 밖(후속).
- 자금 이동을 TRADE로 묶고 기본 `canTrade=false`를 유지하면, 별도 withdraw scope 없이도 "읽기 전용 키는 자금을 못 옮긴다"는 핵심 안전성을 확보.
- 단일 `FundingTx` 원장이 3종 이동을 한 화면에서 보여주기에 가장 단순. Binance식 분리 엔드포인트(deposit/withdraw/transfer 별도)는 UI 요구가 통합이라 채택 안 함.

## Consequences

- **Schema 변경**: `FundingTx` 모델 + `FundingTxType` enum + `User.fundingTxs` 관계. 마이그레이션 1건(대기 중인 `marginMode`와 함께 적용).
- **기존 동작 보존**: 웹 세션 경로 불변. API key 경로만 권한 강제 추가 → 기존에 full 권한을 가정한 외부 호출 중 `canTrade=false` 키의 mutating 호출은 이제 403(의도된 변화).
- **테스트**: funding/transfers service spec의 mock에 `$transaction`/`fundingTx` 추가. 단위 203/203 그린.
- **후속(범위 밖)**: withdraw 전용 scope, IP whitelist enforcement, key expiry, per-key rate limit, preferences 토글의 소비처 연동(주문 확인/잔고 숨김).

## 관계
- [ADR-019](019-api-key-with-hmac-signature.md): security type을 정의했고 enforcement를 미뤘음 — 본 ADR이 그 후속을 구현
- [ADR-042](042-binance-like-api-docs.md): API docs — 본 ADR의 scope/`/account/transactions`가 문서에 반영됨
