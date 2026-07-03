# ADR-035: spot/futures 멀티앱(S4) 전환

## Status
Accepted

## Context

[ADR-027](027-futures-code-separation-and-deployment.md)은 [ADR-018](018-product-prefix-and-deployment-options.md)의 S3(단일 앱 + `MARKETS_ENABLED` 조건부 조립)을 채택했고, futures MVP가 그 구조 위에서 검증됐다. 이제 spot/futures를 배포 단위로 분리한다(S4: Nest monorepo 멀티앱).

DB 멀티스키마 분리(core/spot/futures Postgres 스키마 + Order/Trade/SettlementEvent 테이블 분할)를 함께 검토했으나 **기각**했다:
- 같은 인스턴스 안의 스키마 분리는 네임스페이스 정리일 뿐 격리가 아니다 — 커넥션 풀, 장애 도메인, 백업, 마이그레이션 히스토리(Prisma는 datasource당 1개)가 전부 공유된다. 배포·장애 격리는 프로세스 분리(S4)가 달성한다.
- 비용은 구체적이다: 파괴적 마이그레이션 + 모델 rename(`Order`→`FuturesOrder` 등)이 검증 완료된 futures 코드 전체에 파급되고 Stage 검증 재실행이 필요하다.
- 단일 Order 테이블의 비용(partial index, futures 전용 컬럼, `tickerMarket=SPOT` 강제)은 [ADR-015](015-single-order-table-with-partial-index.md)/[ADR-027](027-futures-code-separation-and-deployment.md)에서 이미 지불·봉합됐다.

따라서 [ADR-001](001-single-db-with-market-type.md)(단일 DB + MarketType)과 ADR-015(단일 Order 테이블)는 그대로 유지된다. 본 ADR 범위는 BE 코드 구조와 배포 형상이며, FE(bitshuriken-v2-fe)는 단일 Next.js 앱 유지(API/WS base URL만 product별 분리).

## Decision

### 1. Nest monorepo 멀티앱 (apps/ + libs/)

`nest-cli.json`을 monorepo 모드로 전환하고 다음과 같이 재배치한다.

```
bitshuriken-v2-be/
  apps/
    spot/                  ← 현 spot 묶음 + cross-product /auth
      src/main.ts          (포트 5101)
      src/http/rest/{auth, spot}/
      src/http/ws/                       ← /ws/market, /ws/user
      src/consumer/                      ← match.spot.{out,book} (현 infra/messaging의 spot 컨트롤러)
      src/domain/{order, trade, settlement, trigger, order-list, user-stream}/
    futures/               ← 현 src/futures/** 그대로
      src/main.ts          (포트 5102)
      src/...              (http, ws, consumer, settlement, position, margin,
                            mark-price, funding, liquidation, config, math, user-events)
  libs/
    shared/                ← decimal, exceptions, filters, interceptors, ws 베이스 등
    infra/                 ← kafka(producer, topics, 메시지 파서), prisma
    core-domain/           ← auth, user, api-key, wallet, ticker, orderbook, kline
  prisma/                  ← 루트 유지 (단일 schema.prisma, 변경 없음)
```

- **`MARKETS_ENABLED` env 폐기.** 활성 product가 앱 자체가 되므로 조건부 조립이 사라진다. 각 앱 main.ts는 자기 토픽만 구독하고 Kafka groupId를 고정한다 (`bitshuriken-be-spot` / `bitshuriken-be-futures`, 인덱스용 `bitshuriken-futures-index` 유지).
- **eslint 경계 갱신**: ADR-027의 futures↛spot 도메인 import 규칙은 물리적 분리로 대체된다. 남기는 규칙: `apps/*` 상호 import 금지, `libs/*` → `apps/*` import 금지.
- **kline**: libs/core-domain 소유. ADR-027이 조건부 공유로 남겨둔 항목인데, 현행 futures market API가 이미 `domain/kline`을 사용 중(market 파라미터화 통과)이므로 공유가 기정사실 — 복제가 아닌 공유 lib로 확정.

### 2. cross-product 엔드포인트 호밍

| 경로 | 호스트 앱 | 근거 |
|--|--|--|
| `/auth/*`, api-key 관리 | spot 앱 | 별도 identity 앱은 현 규모에 과함. JWT 검증은 libs/core-domain으로 양쪽 공유 |
| `/account/transfers` | futures 앱 | ADR-027 §1 현행 유지 (transfer 수요가 futures 쪽 기능) |

identity 트래픽/배포 요구가 분리되는 시점에 세 번째 앱(`apps/account`)으로 추출 — 그때 별도 ADR.

### 3. DB·Prisma: 변경 없음

단일 `schema.prisma`, 단일 생성 클라이언트를 libs/infra에 두고 양 앱이 공유한다. 마이그레이션 없음.

### 4. 전환 순서

| Phase | 내용 | 검증 |
|--|--|--|
| 1 | 본 ADR 확정 | — |
| 2 | monorepo 전환: nest-cli/tsconfig/eslint 전환, apps·libs 재배치, main.ts 2개, MARKETS_ENABLED 제거, import 경로 수정 | 양 앱 독립 빌드·부팅, 기존 테스트 전체 통과 |
| 3 | 운영 형상: .env(포트 5101/5102), docker-compose, 실행 스크립트, FE의 API/WS base URL product별 분리, 루트 CLAUDE.md How-to-run 갱신 | FE에서 spot/futures 양쪽 거래 플로우 |
| 4 | 정리: ADR-027 superseded 표기, 죽은 조건부 조립 코드 제거 | lint/test 전체 통과 |

## Rationale

- **격리 이득이 이제 실재** — spot/futures 양쪽 구현이 살아있고 검증됐으므로, ADR-027이 "추출 단위"로 보존해 둔 `src/futures/` 폴더 경계를 실제 배포 단위로 승격할 시점이다. 한쪽 배포/장애가 다른 쪽을 건드리지 않는다.
- **DB는 건드리지 않는다** — 멀티앱의 목표(배포·장애 격리)에 DB 변경이 기여하는 바가 없고, ADR-001의 근거(유저 샤딩 호환, cross-margin 확장)는 여전히 유효하다. 마이그레이션이 없으므로 전환 전체가 순수 코드 재배치가 되어 리스크가 한 단계 내려간다.
- **ADR-027의 격리가 선행 투자였다** — eslint import 경계 덕에 futures 추출은 폴더 이동에 가깝고, spot 쪽 분리도 허용 목록 9건 이외 침식이 없어 경계가 명확하다.

## Consequences

- BE 프로세스가 2개가 된다 (5101/5102). FE는 product별 base URL env가 필요하다.
- `MARKETS_ENABLED`가 사라진다 — 기존 .env에서 제거. [feedback-013](../feedback/013-env-only-deployment-variant.md)의 deployment-variant 역할은 "어느 앱을 띄우는가"로 대체.
- 공통 코드 수정(libs/*)은 이제 양 앱 동시 영향 — 변경 시 양쪽 빌드·테스트가 게이트.
- DB 멀티스키마는 기각이지 봉인이 아니다 — product별 테이블 분리가 실제로 필요해지면 그 시점 데이터 마이그레이션 비용을 안고 별도 ADR로 재검토.

## 관계
- [ADR-001](001-single-db-with-market-type.md): 유지 — 멀티스키마 분리 검토 후 기각
- [ADR-015](015-single-order-table-with-partial-index.md): 유지
- [ADR-018](018-product-prefix-and-deployment-options.md): S4 실행. 외곽 prefix URL 구조는 그대로 유효
- [ADR-027](027-futures-code-separation-and-deployment.md): superseded 예정 (Phase 4) — S3 조건부 조립이 멀티앱으로 대체. `src/futures/` 격리 원칙은 apps/futures로 승계
