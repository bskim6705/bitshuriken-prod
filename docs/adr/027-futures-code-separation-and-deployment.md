# ADR-027: futures 코드 분리와 배포 토폴로지

## Status
Superseded by [ADR-035](035-multi-app-split.md) — S3 조건부 조립이 멀티앱(S4)으로 대체됨. `src/futures/` 격리 원칙은 `apps/futures`로 승계.

## Context

futures MVP가 실제 코드 작업에 들어간다. [ADR-018](018-product-prefix-and-deployment-options.md)이 보존해 둔 배포 단계(S0~S5) 중 어디서 시작할지, futures 코드를 spot과 어떻게 격리할지를 확정해야 한다.

별도 NestJS 앱(S4 monorepo / S5 별도 repo)을 검토했으나 기각했다. 단일 DB([ADR-001](001-single-db-with-market-type.md))를 양쪽이 공유하고, auth/user/wallet 같은 cross-product 자산도 공유해야 하므로, 앱을 쪼개도 결국 같은 스키마·같은 공유 라이브러리를 바라보게 된다. 단일 dev MVP에서 이 구조는 격리 이득 없이 모노레포 툴링(workspace, 빌드 파이프라인) 비용만 추가한다.

남는 문제는 단일 앱 안에서의 경계다. ADR-018은 futures 작업 시 "기존 spot 코드 수정 금지"를 원칙으로 두었지만, 조건부 조립·보안 수정 등 실제로 손대야 하는 spot/공유 파일이 있다. 무엇을 허용하는지 명시하지 않으면 경계가 침식된다.

## Decision

**ADR-018의 S3을 실행한다: 단일 NestJS 앱 + `MARKETS_ENABLED` env 조건부 조립.** S4/S5는 채택하지 않되, 아래 폴더 구조가 곧 S4 이행 경로가 되도록 격리를 유지한다.

### 1. self-contained `src/futures/` 서브트리

futures 로직 전부가 이 폴더 안에 산다. 미래의 별도 앱 후보이며, 이 폴더 밖에 futures 로직을 두는 것을 금지한다.

```
src/futures/
  futures.module.ts           ← 단일 barrel
  http/
    trading/ account/ market/ ← /futures/* REST
    transfers/                ← POST /account/transfers (cross-product 경로, futures 프로세스가 호스팅)
    ws/                       ← /ws/fmarket, /ws/fuser
  consumer/                   ← match.futures.{out,book} 소비 + match.spot.out TR read-only(인덱스용)
  settlement/                 ← futures 전용 worker
  position/ margin/ mark-price/ funding/ liquidation/ config/
```

### 2. eslint import 경계

`no-restricted-imports` / `import/no-restricted-paths`로 강제한다.

- `src/futures/**` → 허용: `infra/**`, `shared/**`, `domain/{auth,user,wallet,ticker,orderbook}` (+ `domain/kline`은 market 파라미터화 확인 후)
- `src/futures/**` → 금지: `domain/{order,trade,settlement,trigger,order-list,user-stream}` (spot 소유)
- 역방향: spot/공유 코드는 `src/futures/**` import 금지 (app.module 조건부 import만 예외)

### 3. ENV 조건부 조립

`MARKETS_ENABLED`(예: `spot,futures`)는 필수 env — 없으면 throw. spot 묶음 = SpotHttpModule + MatchResultModule + MarketDataModule + WsModule, futures 묶음 = FuturesModule.

Kafka consumer groupId는 역할별로 분리한다: 메인 consumer는 `bitshuriken-be-` + markets join (예: `bitshuriken-be-spot`, `bitshuriken-be-spot-futures`), 인덱스용 `match.spot.out` 구독은 별도 groupId(`bitshuriken-futures-index`).

### 4. 매칭엔진: 코드 공유 + config 분리로 인스턴스 분리

엔진 코드는 spot/futures가 공유하고, `config/tickers.json`을 `tickers-spot.json` / `tickers-futures.json`으로 분리해 `MATCH_CONFIG_PATH`로 인스턴스를 따로 띄운다 ([ADR-013](013-match-engine-lane-architecture.md)의 1 인스턴스 N ticker 구조 그대로).

### 5. spot/공유 파일 수정 허용 목록

ADR-018의 "기존 spot 코드 무수정" 원칙에 대한 **명시적 예외**. 아래 9건 이외의 spot/공유 파일 수정은 금지한다.

1. `src/domain/settlement/settlement.worker.ts` — kind 필터(`kind IN (TRADE, DUST_REFUND)`) + 미지의 leg 타입 throw
2. `src/infra/messaging/match-result.controller.ts`(+module) — `match.futures.out` 핸들러 제거
3. `src/infra/messaging/market-data.controller.ts` — `match.futures.book` 핸들링 제거 (futures consumer가 자체 처리)
4. `src/http/rest/spot/**` — `tickerMarket=SPOT` 강제 (현재 FUTURES가 통과되는 보안 구멍 봉합)
5. `src/app.module.ts`, `src/main.ts` — 조건부 조립 + groupId
6. `eslint.config.mjs` — 경계 규칙 추가
7. `prisma/schema.prisma`, `prisma/seed.ts` — additive 변경만
8. `docker-compose.yml`, `bitshuriken-v2-match/config/*` — 엔진 인스턴스 분리
9. FE: `lib/ws/client.ts`(또는 상응 파일) path 파라미터화, 네비게이션에 futures 링크

## Rationale

- **S3이 최소 비용 분리점** — 같은 image, env만 다르게 해서 프로세스를 나눌 수 있다. 단일 dev MVP에서 모노레포는 빌드/배포 복잡도가 즉시 비용이 되는 반면 격리 이득은 폴더 경계로 이미 얻는다.
- **폴더 경계 = S4 이행 경로** — `src/futures/`가 import 경계까지 지키며 self-contained이면, 미래의 `apps/futures-be` 추출은 폴더 이동에 가깝다. 옵션 보존이 ADR-018의 핵심이었고 본 ADR은 그것을 깨지 않는다.
- **eslint 강제** — 경계를 문서로만 두면 침식된다. lint 단계에서 기계적으로 거부해야 `if (marketType === FUTURES)` 분기가 spot 코드에 스며드는 것을 막을 수 있다.
- **허용 목록의 명시** — "무수정 원칙 + 예외 9건"이 "적당히 필요한 만큼 수정"보다 검증 가능하다. 목록 밖 수정이 보이면 그 자체가 리뷰 신호다.
- **groupId 역할별 분리** — 같은 토픽을 다른 목적(정산 vs 인덱스 계산)으로 읽는 consumer가 offset을 공유하면 한쪽 장애가 다른 쪽을 굶긴다.
- **엔진은 config만 분리** — 엔진은 이미 product 무관 설계([ADR-013](013-match-engine-lane-architecture.md))라 코드 분기가 필요 없다. 인스턴스 분리로 spot/futures 장애 격리를 얻는다.
- **`MARKETS_ENABLED`는 deployment-variant env** — 활성 product는 배포 형상의 문제이므로 env가 맞다 ([feedback-013](../feedback/013-env-only-deployment-variant.md)). 없으면 throw하여 암묵 디폴트를 두지 않는다.

## Consequences

- 부팅에 `MARKETS_ENABLED`가 필수가 된다 — 기존 `.env`에 추가하지 않으면 BE가 뜨지 않음 (fail loudly).
- `match.futures.out`/`match.futures.book` 핸들링이 spot 공유 컨트롤러에서 futures consumer로 이동 — spot-only 배포에서 futures 토픽을 건드리지 않게 됨.
- 엔진 프로세스가 2개가 된다 (spot/futures config 각 1개). docker-compose/실행 스크립트 갱신 필요.
- eslint 경계 규칙이 추가되어 futures 작업 중 spot 도메인 import는 lint 실패로 드러난다.
- `domain/kline` 공유는 market 파라미터화 확인을 통과해야 확정 — 실패 시 futures 쪽 별도 구현으로 전환.
- S4(모노레포)로 가는 날이 오면 본 ADR의 폴더 경계가 추출 단위가 된다. 그 전까지 추가 툴링 없음.

## 관계
- [ADR-001](001-single-db-with-market-type.md): 단일 DB — 별도 앱을 기각한 핵심 근거
- [ADR-013](013-match-engine-lane-architecture.md): 엔진 Lane 구조 — config 분리만으로 인스턴스 분리가 가능한 이유
- [ADR-018](018-product-prefix-and-deployment-options.md): S0~S5 옵션 보존 — 본 ADR이 S3을 실행하고, "spot 무수정" 원칙에 명시적 예외 목록을 등재. ADR-018 §5가 예고한 futures 배치(`http/rest/futures/*`, `domain/futures/*`, `FuturesHttpModule`)는 본 ADR의 self-contained `src/futures/` 서브트리(단일 barrel `FuturesModule`)로 대체
- [feedback-013](../feedback/013-env-only-deployment-variant.md): env는 deployment-variant만 — `MARKETS_ENABLED`의 근거
