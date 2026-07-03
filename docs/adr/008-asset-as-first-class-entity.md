# ADR-008: Asset을 1급 엔티티로 분리, Ticker는 base/quote를 FK로 보유

## Status
Accepted

## Context
초기 스키마는 Wallet과 Ticker가 자산을 단순 문자열(`symbol: String`)로 보유했다. 자산 메타데이터(이름, 본질적 소수점, 유형)가 없어 다음 문제가 발생한다:

- 같은 자산이 여러 곳에 흩어져 있어도 일관성 강제 불가 (BTC vs btc 같은 오타)
- 자산별 정보(precision, name, type)를 저장할 곳이 없음
- Ticker가 base/quote를 모르므로 매수/매도 시 어느 wallet에서 차감/적립할지 BE가 매번 조합 분해해야 함

## Decision
- `Asset`을 1급 엔티티로 분리
- `Ticker`가 `baseAssetSymbol`, `quoteAssetSymbol`을 FK로 보유
- `Wallet`이 `assetSymbol`을 FK로 보유

### 구조

```
Asset
├─ symbol     String  @id        // "BTC", "USDT"
├─ name       String              // "Bitcoin"
├─ precision  Int                 // 자산 본질적 소수점 (BTC=8, USDT=6)
└─ type       AssetType           // CRYPTO, STABLECOIN, ...

Ticker
├─ symbol            String         // "BTCUSDT"
├─ marketType        MarketType
├─ baseAssetSymbol   FK → Asset
├─ quoteAssetSymbol  FK → Asset
├─ pricePrecision    Int            // 거래소 호가 소수점 (Binance tickSize)
└─ amountPrecision   Int            // 거래소 수량 소수점 (Binance stepSize)

Wallet
├─ userId
├─ assetSymbol  FK → Asset
├─ marketType   MarketType
├─ balance      Decimal
└─ locked       Decimal
```

## Rationale

- **자산 메타 일관성**: Asset이 단일 출처가 되므로 오타/불일치 원천 차단.
- **Ticker → base/quote 직접 조회**: 정산 로직이 Ticker만 참조해서 어떤 Asset에서 차감/적립할지 즉시 알 수 있다. 문자열 파싱 불필요.
- **Asset.precision vs Ticker.{price,amount}Precision 구분**:
  - `Asset.precision`: 자산의 본질적 소수점 (BTC = 8, satoshi 단위 / USDT = 6)
  - `Ticker.amountPrecision`: 거래소가 호가/체결 시 받아주는 표시 소수점 (BTCUSDT spot = 5)
  - 둘은 다르며 모두 필요. Asset.precision은 잔고/회계 정확도, Ticker precision은 입력 검증/UI 표시.
- **Wallet은 marketType 분리 유지**: Spot/Futures의 BTC 잔고는 격리. 대부분 거래소가 이렇게 동작.
- **Asset에는 marketType 없음**: 자산 자체는 마켓에 종속되지 않는다. 격리는 Wallet 레이어에서.
- **Ticker.symbol은 명시 저장**: `base+quote`로 derive 가능하지만 거래소마다 표기가 달라(`BTCUSDT`, `BTC-USDT`, `BTC/USDT`) 명시가 안전.

## Consequences

- 마이그레이션 필요: 기존 Wallet/Ticker의 `symbol` 컬럼을 FK로 전환. 개발 DB는 리셋으로 처리.
- Seed에 Asset(BTC, ETH, USDT 등) 먼저 생성 후 Ticker, Wallet 생성하도록 수정 필요.
- 신규 자산 상장은 Asset → Ticker → (사용자별) Wallet 순서.
- 향후 Asset에 추가 메타(아이콘 URL, 체인 정보, 입출금 가능 여부 등) 확장 자연스러움.
