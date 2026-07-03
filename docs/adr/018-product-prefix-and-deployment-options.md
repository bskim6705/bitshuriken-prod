# ADR-018: 외곽 product prefix (`/spot`, `/futures`) + 단일 앱으로 시작, 미래 분리 경로 보존

## Status
Accepted. Supersedes [ADR-017](017-product-split-inside-trading-only.md).

## Context

[ADR-016](016-rest-folder-by-use-case.md)에서 REST를 use case 기준(`trading/`, `account/`, `market/`)으로 정리했고, [ADR-017](017-product-split-inside-trading-only.md)에서는 "product split은 `trading/` 안에서만" 정책을 두었다. ADR-017이 가정한 것은 spot/futures가 같은 host에 사는 Bybit/OKX 스타일이었다.

그 후 다음 요구가 추가됐다:
- **product가 늘면 인스턴스/배포 단위로 분리할 가능성을 열어두고 싶음**. 한 host 가정을 포기.
- 다만 **단일 dev MVP**라 monorepo / multi-app으로 미리 가는 것은 과함.
- spot 외 product (futures, options 등)는 아직 코드 0. 미리 작성하지 않음 ([ADR-004](004-spot-first-then-futures.md), [feedback-001](../feedback/001-no-premature-implementation.md)).

핵심 결정 포인트는 두 가지:
1. **URL 구조**: product가 외곽인가, use case가 외곽인가
2. **배포 분리 전략**: 같은 코드/같은 image/같은 process로 갈 수 있는 옵션을 어디까지 보존할 것인가

## Decision

### 1. URL: 외곽 prefix는 product

```
/auth/...                       ← cross-product (signup, login)
/spot/trading/orders            ← POST  (auth)
/spot/trading/orders/:id        ← DELETE (auth)
/spot/account/balances          ← GET   (auth)
/spot/account/orders            ← GET   (auth)
/spot/account/orders/:id        ← GET   (auth)
/spot/account/trades            ← GET   (auth)
/spot/market/tickers            ← GET   (public)
/spot/market/recent-trades      ← GET   (public)
(미래) /futures/...
(미래) /options/...
```

- `?market=SPOT` query 파라미터 금지. product는 path 첫 segment로만 표현.
- auth는 product 무관 (한 user가 spot/futures 모두 사용) → prefix 밖.
- 자기 user 정보 같은 것도 cross-product이면 prefix 밖 (`/account/...` 아님 `/spot/account/...`인 이유: balance/orders/trades는 product 단위 의미가 명확).

### 2. 폴더: http/rest/{spot, auth}로 외곽 prefix 반영

```
src/http/rest/
  auth/                          ← cross-product
    auth.controller.ts
    auth.module.ts
  spot/
    spot.module.ts               ← SpotHttpModule (barrel: trading/account/market 묶음)
    trading/
      trading.controller.ts      → /spot/trading/...
      trading.module.ts
    account/
      account.controller.ts      → /spot/account/...
      account.module.ts
    market/
      market.controller.ts       → /spot/market/...
      market.module.ts
  # (미래) futures/
```

- futures 폴더는 **만들지 않음**. premature 추상화 방지.
- `SpotHttpModule`이 `/spot/*` 전체를 한 import 단위로 묶음 → 미래 conditional import가 한 줄.

### 3. 도메인은 prefix 받지 않음 (지금)

```
src/domain/
  order/      ← spot 전용 (현재). futures 추가 시 새 모듈 권장.
  wallet/
  ticker/
  trade/
  settlement/
  user/
  auth/
```

- 현 단계에선 `domain/order`가 곧 spot order. spot 전제.
- futures가 들어올 때의 규칙은 아래 5번 참조.

### 4. 배포 전략: 단일 NestJS 앱 + 미래 분리 경로 보존

조사 결과 4가지 옵션:
1. **단일 앱 + ENV-conditional module loading** ⭐
2. NestJS Monorepo (workspace mode, `apps/`/`libs/`)
3. Git monorepo + 별도 NestJS 앱 (nx/turborepo)
4. 별도 repo

**채택: 옵션 1.** 한 코드베이스, 한 main.ts. spot/futures 활성화는 환경변수로 결정 가능한 형태로 설계해두되, 지금은 spot만 import.

미래 conditional import는 한 줄짜리:
```typescript
const httpModules = [];
if (env.MARKETS_ENABLED.includes('spot'))    httpModules.push(SpotHttpModule);
if (env.MARKETS_ENABLED.includes('futures')) httpModules.push(FuturesHttpModule);
```

`SpotHttpModule`이 `spot/{trading,account,market}.module`을 묶고 있으므로 import 한 줄로 `/spot/*` 전체가 활성/비활성.

### 5. 미래 product 추가 시 규칙

futures가 실제로 작업에 들어갈 때:

**새로 만들어야 하는 것 (기존 spot에 if 분기 금지)**:
- `domain/futures/order/`, `domain/futures/trade/`, `domain/futures/settlement/`
- `http/rest/futures/{trading,account,market}/`
- `http/rest/futures/futures.module.ts` (`FuturesHttpModule` barrel)

**공유 검토 가능 (그 시점에 결정)**:
- `domain/user/`, `domain/auth/` — identity는 cross-product
- `domain/ticker/` — 메타 정보. spot/futures 양쪽이 ticker 정의를 가지면 한 테이블에 marketType으로 구분도 OK
- `domain/wallet/` — cross-margin이 필요한가에 따라 다름. UTA 스타일이면 통합, Binance 스타일이면 분리

**Kafka topic / 매칭엔진**: 이미 product별 분리됨 ([ADR-010](010-kafka-topic-unification-for-ordering.md), [ADR-013](013-match-engine-lane-architecture.md)). 추가 결정 불필요.

## Future split scenarios (이 ADR이 보존하는 옵션)

prefix가 외곽이고 SpotHttpModule이 분리되어 있으면 다음 단계가 모두 가능:

| 단계 | 무엇이 바뀌는가 | 코드 변경 |
|--|--|--|
| **S0** 현재 | 단일 앱, AppModule이 모든 prefix import | — |
| **S1** futures 추가 | `FuturesHttpModule`, `domain/futures/*` 신설. AppModule에 import 추가 | controller 추가만 |
| **S2** 인스턴스 분리 (같은 image) | gateway path 라우팅. `/spot/* → spot-be replicas`, `/futures/* → futures-be replicas` | 코드 0, k8s manifest |
| **S3** ENV-conditional | `MARKETS_ENABLED=spot`로 부팅 시 SpotHttpModule만 import. 같은 image, 다른 env | app.module if 분기 추가 |
| **S4** Nest monorepo | `apps/spot-be`, `apps/futures-be`, `libs/domain-*`로 마이그레이션 | 폴더 재배치 |
| **S5** 별도 repo | 완전 독립 | 매우 큼 |

각 단계는 이전 단계를 무효화하지 않으며, 단계적으로 진행 가능. **현재는 S0이고, 본 ADR은 S1~S5의 모든 경로를 보존하는 것을 목표로 한다.**

도메인 분리 (S4 이상)는 futures가 실제로 코드 작업에 들어갈 때 결정. 지금은 빈 도메인 폴더를 만들지 않는다.

## Rationale

- **외곽 prefix는 거의 무료** — controller path 한 줄, 폴더 한 단계. URL space 예약은 코드 작성과 다름 (ADR-004에 위반 아님).
- **gateway 라우팅이 자명** — path 첫 segment가 product. nginx/k8s ingress 1줄.
- **`?market=SPOT` query 파라미터의 함정 회피** — 라우팅이 query를 파싱해야 하는 이상한 구조 + controller 안 if 분기로 흩어짐 위험.
- **단일 앱으로 시작** — monorepo는 큰 팀의 도구. 단일 dev에서는 빌드/테스트/배포 파이프라인 복잡도가 즉시 비용이 됨. 미래에 monorepo로 갈 길은 열려있음 (S4).
- **`SpotHttpModule` barrel 패턴** — 미래 conditional import가 한 줄로 끝나는 자리. 지금은 단순한 묶음이지만 미래 가치가 큼.
- **auth는 prefix 밖** — Bybit/OKX/Binance 모두 identity는 cross-product. 한 사용자가 spot/futures를 같은 token으로 사용. spot/auth가 되면 어색.
- **도메인은 평탄 유지** — futures가 없는데 `domain/spot/order/`를 만들면 빈 추상화. 도메인 분리는 두 product가 살아있을 때 의미가 있음.

## Consequences

- 모든 REST URL이 prefix 한 단계 길어짐 (`/trading/orders` → `/spot/trading/orders`)
- FE 미연동 상태이므로 외부 영향 0
- `SpotHttpModule`이라는 barrel 모듈 1개 신설
- `recent-trades`에서 `?market` query 파라미터 제거 — path가 알게 됨
- ADR-017은 superseded. 본 ADR이 그 내용을 흡수.
- 미래 futures 작업 시:
  - 새 도메인 모듈로 시작 (기존 spot 코드 수정 금지)
  - `FuturesHttpModule` barrel
  - `MARKETS_ENABLED` 같은 env로 conditional import 도입은 운영 분리가 필요할 때
- DB schema, Wallet 모델, Kafka topic 등은 이미 product 인지 가능 (marketType 필드, topic 이름). 본 ADR과 직교

## 관계
- [ADR-004](004-spot-first-then-futures.md): spot 먼저 — 본 ADR이 그 원칙을 URL/배포 정책으로 구체화
- [ADR-010](010-kafka-topic-unification-for-ordering.md): Kafka topic이 이미 product별
- [ADR-013](013-match-engine-lane-architecture.md): 매칭엔진이 이미 product별
- [ADR-016](016-rest-folder-by-use-case.md): use case grouping은 spot/ 안에 보존됨
- [ADR-017](017-product-split-inside-trading-only.md): superseded by this ADR. 본 ADR이 한 host 가정을 버리고 외곽 prefix로 변경
- [feedback-001](../feedback/001-no-premature-implementation.md): 빈 futures 폴더 만들지 않는 근거
