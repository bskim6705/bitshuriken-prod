# ADR-076: 제품 성숙도 단계(alpha/beta/GA)와 장애 반경 격리 — spot GA, futures beta

## Status
Accepted (2026-09-16, 유저 결정)

## Context
프로덕션 목표는 "spot·futures 완성도"([ADR-065](065-production-fork.md))다. 2026-09-16 시점의 실제 상태는 두 제품이 다르다.

- **spot**: 미러링 사이클 3에서 정합성 F1~F5 클린, 7심볼 p99 2.7~6.3bps(rec150/TPS20), kill -9 리플레이 대조 불일치 0. 접수→체결→정산→WS 경로 전부가 실측으로 검증됐다(`docs/test-reports/2026-08-24-*`).
- **futures**: 코어 경로(접수·마진·체결·apply·청산·펀딩)는 같은 캠페인에서 검증됐지만, M1 정산 프로세스 분리(`apps/settle`) 이후 생긴 결함이 남아 있다.
  1. `positionUpdate` / `outboundAccountPosition` / per-fill `executionReport`가 클라이언트에 도달하지 않는다 — 발행자(`consume.service`, `settle.worker`)는 settle 프로세스, 구독자(`WsFuturesUserGateway`)는 API 프로세스이고 둘 사이는 in-process EventEmitter다. FE는 REST 폴링(포지션 패널 5s)에 의존한다.
  2. settle 워커의 포지션 스냅샷 보강이 `NULL_MARK_READER` 바인딩(`settle.module`)으로 영구 null.
  3. 런타임 상장 심볼은 mark가 생기지 않는다(`mark-price.service`가 부팅 시 1회만 심볼 로드) → 해당 심볼 주문 503, 펀딩 실패. 재시작이 유일한 해소.
  4. cross 담보를 S2(`LEDGER_TRUTH`)에서도 지연된 Wallet 행으로 읽는다(`liq.executor`) → 청산 판정이 stale balance를 볼 수 있다.
  5. 죽은 코드: 어디에도 배선되지 않은 `futures-match-result.controller.ts`(2026-09-16 제거), 사용처 0인 `BalanceJournalKind.FUTURES_LIQUIDATION`(enum 제거는 마이그레이션 필요).

포트폴리오 공개·재배포를 앞두고 두 질문이 열려 있었다. ① 기한 안에 futures를 다듬을 수 없다면 제외할 것인가. ② 제외하지 않는다면 미완성을 어떻게 표시하고, 어떤 조건에서 완성으로 올리며, 그동안 **futures의 장애가 spot·portal을 건드리지 않는다**는 것을 무엇으로 보장할 것인가.

## Decision

### 1. 제품 성숙도 단계
| 단계 | 의미 | 진입 조건 | 노출 | 배포 | 장애 정책 |
|---|---|---|---|---|---|
| **alpha** | 내부 실험. 데이터 리셋 가능 | ADR + 자기 앱·프로세스·토픽 | 내비 미노출, 직접 URL만 | compose profile로만 기동(기본 off) | 언제든 꺼도 됨 |
| **beta** | 공개 사용 가능, 알려진 한계 명시 | 코어 경로 정합성 드릴 클린 + 한계 목록 + §4 격리 요건 | 내비 `BETA` 배지 + 페이지 상단 한계 배너 | 기본 기동, 자원 상한 | 장애 허용. 단 GA 저하 금지 |
| **GA** | 완성 제품 | 한계 목록 소진 + 격리 드릴 + 런북 + 문서 정합 | 표시 없음 | 기본 기동 | 장애 = 사고 |

### 2. 현재 배정
| 제품 | 단계 | 근거 |
|---|---|---|
| spot (`be-spot`, `match-spot`, `/trade`) | **GA** | Context의 검증 |
| portal (인증·이체·계정·리더보드) | **GA** | cross-product 코어. REST 전용 — Kafka는 상장 컨트롤 produce만, 컨슈머·WS 없음([ADR-036](036-portal-app.md)) |
| futures (`be-futures`, `match-futures`, `/futures`) | **beta** | 코어 검증됐으나 M1 이후 결함 5건 |
| options, dex | 없음 — v2 아카이브(ADR-065) | 재도입 시 §7로 alpha 진입 |
| fly(초파리 커넥톰) | 제품 아님 — 별도 실험 프로젝트([ADR-075](075-fly-connectome-trading-brain.md), feedback-029) | 단계 체계 밖 |

### 3. 단계의 표현
- 단계는 **코드 상수**다: FE `src/lib/product-stages.ts`의 `PRODUCT_STAGES`. env가 아닌 이유는 [feedback-020](../feedback/020-policy-constants-not-in-env.md)(정책·상수는 코드/DB). [ADR-027](027-futures-code-separation-and-deployment.md)의 `MARKETS_ENABLED`는 "어느 배포에 어떤 앱을 띄우나"(deployment variant, feedback-013)였고, 단계는 배포와 무관하게 동일해야 하는 제품 정책이다.
- beta 표시: 상단 내비 항목 옆 `BETA` 배지 + 해당 제품 페이지 상단 배너(알려진 한계 요약, 본 ADR 참조). 배너는 세션당 닫을 수 있다. alpha는 내비에서 제외된다.
- README 상단에 단계와 격리 원칙을 한 문단으로 적는다.
- 단계 조회 BE 엔드포인트는 두 번째 beta 제품이 생길 때까지 만들지 않는다(feedback-001).

### 4. 장애 반경 규칙 — "beta 제품의 장애는 GA 제품을 저하시키지 않는다"
- (a) **자기 프로세스·컨테이너.** beta 컨테이너에는 메모리 상한(`deploy.resources.limits.memory`)을 둔다. 상한이 없으면 폭주 시 호스트 OOM killer가 postgres·kafka를 고를 수 있다.
- (b) **자기 Kafka 토픽·컨슈머 그룹·엔진 인스턴스.** (ADR-027 §4, [ADR-062](062-production-deployment.md) §5의 원칙을 컨슈머 그룹까지 확장)
- (c) **의존 방향은 beta → GA만.** GA 코드는 beta 프로세스의 생존을 전제하지 않는다. futures의 mark index가 spot 체결을 읽는 것은 허용, 역방향은 금지.
- (d) **GA 진입점(nginx)의 기동 의존(`depends_on`)에 beta를 넣지 않는다.** 라우팅은 요청 시점 DNS 해석이므로 beta 부재 = 해당 경로만 502.
- (e) **FE에서 beta API 오류는 beta 라우트 안에 갇힌다.** 공유 페이지(지갑 개요)는 GA 데이터를 그대로 렌더하고 beta 부분만 강등한다.
- (f) **공유 인프라(Postgres·Kafka 브로커·`JWT_SECRET`·FE 번들)는 "공유 운명"으로 명시**하고, GA 승격 전에 예산(커넥션·쿼터)을 둔다.

### 5. 격리 매트릭스 (2026-09-16, 코드·인프라 검증)
futures 측 장애가 spot / portal / settle에 미치는 영향과 근거. 빨간 칸이 GA 종료 조건(§6)이 된다.

| futures 측 장애 | spot | portal | settle | 근거 |
|---|---|---|---|---|
| `be-futures` 프로세스 다운 | 무영향 | 무영향 | 무영향(futures out만 정지) | 별도 컨테이너, 그룹 `bitshuriken-be-futures`. nginx는 `/api/futures/*`·`/api/ws/f*`만 502. portal은 Kafka 컨슈머·WS 없이 DB만 본다(ADR-036). 이체는 DB + 저널 append라 성공하고, be-futures 복귀 시 저널 리플레이([ADR-069](069-in-memory-balance-ledger.md)) |
| `match-futures` 엔진 다운 | 무영향 | 무영향 | 무영향 | `match.futures.*` 토픽·인스턴스 분리. 미체결 NO는 in 토픽에 적체돼 복구 후 처리([ADR-034](034-match-engine-state-recovery.md)) |
| `be-futures` 메모리 폭주 | 무영향 — 컨테이너 상한(2g)에서 be-futures만 OOM-kill → `restart` | 무영향 | 무영향 | 본 ADR로 상한 도입. 이전엔 호스트 OOM killer가 임의 프로세스를 골랐다 |
| `be-futures` CPU 스핀 | 코어 1개 점유(Node 단일 스레드) | 동일 | 동일 | CPU 상한 없음. 4코어 이상 호스트 전제 |
| futures 정산 이벤트 poison(적용 실패 반복) | 무영향 | 무영향 | futures 워커만 5회 후 DLQ 격리. spot 워커는 kind 필터(`TRADE`,`DUST_REFUND`)로 무관 | [ADR-067](067-settlement-dead-letter-queue.md), `settlement.worker`·`futures-settlement.worker`의 kind IN 조건 |
| **`match.futures.out` 메시지 파싱·삽입 실패(unique 위반 외)** | **spot 정산 정지** | 무영향 | **컨슈머 그룹 크래시 루프** | settle은 그룹 `bitshuriken-settle` 하나로 양 마켓 out을 구독하고(`apps/settle/src/main.ts`), 핸들러 예외는 kafkajs onCrash → 같은 오프셋에서 무한 재기동, 전 파티션 정지(2026-07-22 감사 A6 확증). **§4(b) 위반 — GA 전 해소 항목 §6-⑥** |
| settle 프로세스 크래시(futures 워커 unhandled) | spot 정산 **지연** | 무영향 | 재시작 후 이어서 드레인 | `restart: unless-stopped`. `SettlementEvent`는 PENDING으로 DB에, 오프셋은 그룹에 커밋 — 돈은 안 잃고 늦어진다 |
| futures DB 부하(청산 폭주·정산 백로그) | 지연(공유 Postgres) | 지연 | 지연 | [ADR-001](001-single-db-with-market-type.md)/[ADR-035](035-multi-app-split.md) 단일 DB. 행 락은 마켓별 키(Wallet PK에 `marketType`, Position은 futures 전용)라 교차하지 않고, CPU·IO·커넥션만 공유 |
| futures Kafka 홍수 | 지연(공유 브로커) | — | 지연 | 단일 KRaft 브로커, 클라이언트 쿼터 없음 |
| `be-futures` 컨테이너 침해 | 세션 위조 가능 | 동일 | — | `JWT_SECRET` 전 앱 공유(ADR-036). 신뢰 도메인이 하나 |
| FE futures 컴포넌트 렌더 크래시 | 해당 라우트만 에러 경계 | — | — | `app/error.tsx` 라우트 단위. 단 지갑 개요는 선물 잔고 조회 실패 시 0으로 강등되고 오류 표시가 없다(§6-⑨) |
| futures user WS 끊김 | 무영향 | — | — | 소켓이 마켓별로 분리, 지수 백오프 최대 15s |

개발 도구는 별개다: `scripts/exchange.sh start`는 be-futures 기동 실패 시 전체를 중단한다(개발 환경은 전체 스택 전제). 프로드 compose에는 이 결합이 없다.

### 6. futures beta → GA 종료 조건
1. ① `be.user-events` 브로드캐스트 토픽으로 settle → API 이벤트 전달(`docs/specs/tps-and-failover-plan.md` §5.2 M2 ④). 마켓별 토픽으로 만들어 §4(b)를 지킨다.
2. ② settle에 mark reader 배선.
3. ③ 런타임 상장 심볼의 mark 구독(control 토픽 반영).
4. ④ cross 담보를 원장에서 판정.
5. ⑤ 죽은 컨트롤러·enum 제거 — 컨트롤러는 2026-09-16 제거, enum은 마이그레이션 대기.
6. **settle 컨슈머 격리**: 마켓별 settle 프로세스(같은 이미지, `SETTLE_MARKETS` deployment-variant env, 그룹 `bitshuriken-settle-{spot,futures}`, 프로젝터는 소유 마켓만 투영) 또는 최소한 컨슈머 단 파킹 테이블(감사 A6 해법). §5의 빨간 칸을 지운다.
7. **격리 드릴**을 프로드 토폴로지에서 실행: `be-futures` kill -9 / `match-futures` kill -9 / `match.futures.out`에 poison 1건. 각각 spot 주문·정산·WS가 무영향이고 F1~F5 클린.
8. 자원 예산: 앱별 DB `connection_limit`·`statement_timeout`, Kafka 클라이언트 쿼터.
9. FE 지갑 개요의 선물 오류 상태 표시.
10. ADR-028/031/032/033/041의 코드 정합성 배너.
11. 런북: 재기동·DLQ 재적용·펀딩 라운드 스킵 복구.

### 7. 신규 제품(dex 등) 진입 규칙
- alpha로 진입한다: 자기 BE 앱·프로세스·토픽·엔진 config·compose profile(`--profile alpha`, 기본 off), 내비 미노출. 공유 테이블 쓰기는 ADR 필수.
- beta 승격 = §1 조건 + 자기 §5 격리 매트릭스 + §6-7 드릴.
- futures가 GA가 되기 전에는 어떤 제품도 beta 이상으로 올리지 않는다([feedback-019](../feedback/019-validate-core-before-speculative-features.md)).

## Rationale
- **제거가 아니라 beta인 이유.** futures는 settle 프로세스·compose·nginx·FE·Prisma(`MarketType`, `Position`)·ADR 12건에 걸쳐 있다. 걷어내면 ADR-065 규모의 두 번째 포크이고 git 히스토리에는 어차피 남는다. 코어가 검증된 제품을 "미완성 표시 + 격리 보장"으로 두는 것이 정직하고 싸다.
- **단계와 격리를 한 ADR에 묶는 이유.** "beta는 실패해도 된다"는 약속은 실패가 갇힐 때만 성립한다. 격리가 없으면 beta는 GA 제품의 숨은 리스크일 뿐이다.
- **프로세스 경계를 격리 단위로 삼는 이유.** ADR-035가 스키마 분리를 기각한 논거 그대로다 — 장애 도메인·배포·자원은 프로세스 경계에서 갈린다. DB 인스턴스 분리는 P4(멀티인스턴스) 단계의 별도 ADR.
- **매트릭스를 ADR에 두는 이유.** "격리된다"는 주장은 표로 반증 가능해야 한다. 한 칸이라도 빨간 칸이 있으면 그것이 GA 종료 조건이다. 2026-09-16 검증에서 빨간 칸은 settle 공유 컨슈머 하나였다.
- **메모리 상한 값.** be-futures 2g, match-futures 1g. 실측 RSS(수백 MB)의 4배 이상으로 잡아 오탐 kill을 피하고, 16GB 호스트에서 폭주 하나가 전체를 끌어내리는 것만 막는다. GA 제품의 상한은 GA 시점 실측 후 별도.

## Consequences
- FE: `src/lib/product-stages.ts` 신설, 내비 `BETA` 배지, `/futures/*` 상단 배너(i18n 4개 언어).
- infra: nginx `depends_on`에서 `be-futures` 제거, `be-futures`·`match-futures`에 메모리 상한.
- 알려진 미격리 1건(settle 공유 컨슈머)이 명시적 부채가 됐다. 해소 전까지 `match.futures.out` 메시지 스키마 변경은 spot 정산 정지 리스크를 동반하므로 파서 변경은 양 마켓 리플레이 테스트를 거친다.
- 문서: README 상단 단계 문단, 루트 CLAUDE.md에 규칙 한 줄.
- 개발: exchange.sh의 be-futures 의존은 유지(개발 환경은 전체 스택 전제).

## 관계
- [ADR-018](018-product-prefix-and-deployment-options.md): S0~S5 배포 옵션 사다리. 본 ADR은 "제품이 어느 단계에 있나"라는 직교 축을 추가
- [ADR-027](027-futures-code-separation-and-deployment.md) / [ADR-035](035-multi-app-split.md) / [ADR-036](036-portal-app.md): 프로세스 격리의 출발점. 본 ADR은 그 격리를 규칙과 매트릭스로 승격
- [ADR-062](062-production-deployment.md): 엔진 2 인스턴스(장애 격리). nginx `depends_on`과 자원 상한이 본 ADR로 추가
- [ADR-065](065-production-fork.md): options/dex 제외. 재도입 경로는 §7
- [ADR-067](067-settlement-dead-letter-queue.md) / [ADR-069](069-in-memory-balance-ledger.md): 격리 매트릭스의 정산·원장 행 근거
- [ADR-075](075-fly-connectome-trading-brain.md), feedback-029: 실험은 단계 체계 밖
- feedback-001 / 013 / 019 / 020
