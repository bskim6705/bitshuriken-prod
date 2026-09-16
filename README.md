# bitshuriken-prod

Bitshuriken — spot·futures 시뮬레이션 거래소 모노레포.
`bitshuriken-v2`의 시맨틱 포크로, 거래소 코어는 spot/futures/portal에 집중하고
bots/agents는 외부 사용자 표면을 사용하는 전략 테스트 서비스로 함께 둔다
(경위: [ADR-065](docs/adr/065-production-fork.md), [ADR-071](docs/adr/071-git-monorepo.md)).

제품 단계([ADR-076](docs/adr/076-product-maturity-stages-and-blast-radius.md)): **spot·portal GA, futures beta**.
선물은 핵심 경로가 검증됐지만 알려진 한계가 있고(FE 배너 참조), 선물 장애가 spot·portal로 번지지
않도록 프로세스·토픽·컨슈머 그룹·기동 의존을 분리한다(격리 매트릭스는 ADR-076 §5).

## 무엇을 만들었나

Binance 구조를 따라 만든 **현물 + USDT 무기한선물 시뮬레이션 거래소**다. 목적은 전략과 봇을 실제 매칭엔진 위에서 검증하는 것 — Binance·Upbit의 실시간 호가를 미러링해 실시장 부하를 넣고, 금전 불변식 하네스와 kill -9 리플레이 드릴로 정합성을 확인했다.

- **엔진**(Python): 가격-시간 우선 매칭, 심볼 해시 버킷 파티션(P=6)에 여러 티커를 태우는 Lane 패턴, 30초 compacted 스냅샷 + inbound WAL replay로 복구, 결정적 trade id.
- **백엔드**(Nest.js, 프로세스 4개): 접수·잠금은 인메모리 원장 + append-only 저널(응답은 저널 커밋 후), 정산은 이벤트 로그를 별도 프로세스의 워커가 `seq` 순으로 적용, poison 이벤트는 DLQ로 격리.
- **프론트엔드**(Next.js): 거래소 컨벤션의 터미널 UI, WS 스트림, 4개 언어.
- **봇·에이전트**: 미러링 마켓메이커·테이커, 정합성 체커(F1~F5), 부하 생성기, 백테스트·라이브 전략 실행기.

| 항목 | 값 |
| --- | --- |
| 코드 | BE 24k LOC(TS) · 엔진 1.4k(Python) · FE 22k(TS/TSX) |
| 문서 | ADR 68건(번호 001~078, 050~059 결번 — 결정이 바뀐 이유까지) · 교정 기록 33건 · 검증 리포트 16건 |
| 테스트 | jest 42 suites / 419 · pytest 179 + xfail 1 · CI: `.github/workflows/ci.yml` |
| 정합성 | kill -9 리플레이 22,235건·31,999건 대조 불일치 0 · 정합성 체커 F1~F5 0 fail |
| 미러 충실도 | BTCUSDT 호가 p99 편차 2.68bps, 선물 ETHUSDT 6.29bps(rec150/TPS20, 10분) |
| 처리량 | 단일 프로세스 유효 100~120 TPS → 정산 프로세스 분리 후 7심볼 미러 동반 지속 |

## 설계 결정 — 읽는 순서

결정보다 **결정이 바뀐 이유**를 남기려 했다. 이 여섯 개면 뼈대가 보인다.

1. [ADR-013](docs/adr/013-match-engine-lane-architecture.md) 엔진 Lane 패턴 → [ADR-063](docs/adr/063-match-partition-buckets-and-stw.md) 해시 버킷 파티션 → [ADR-064](docs/adr/064-dynamic-ticker-onboarding.md) 런타임 상장
2. [ADR-034](docs/adr/034-match-engine-state-recovery.md) 스냅샷 + WAL replay 복구 → [ADR-038](docs/adr/038-deterministic-trade-id.md) 결정적 trade id
3. [ADR-014](docs/adr/014-async-settlement-via-event-log.md) 이벤트 로그 정산 → [ADR-067](docs/adr/067-settlement-dead-letter-queue.md) DLQ → [ADR-069](docs/adr/069-in-memory-balance-ledger.md) 인메모리 원장 → [ADR-077](docs/adr/077-settlement-process-split-and-graceful-shutdown.md) 정산 프로세스 분리
4. [ADR-028](docs/adr/028-futures-margin-position-model.md) 선물 마진 → [ADR-029](docs/adr/029-mark-price-internal-index.md) 자체 인덱스 mark → [ADR-031](docs/adr/031-liquidation-insurance-fund.md) 청산·보험기금 → [ADR-039](docs/adr/039-cross-margin-per-position-toggle.md) cross
5. [ADR-035](docs/adr/035-multi-app-split.md) 멀티앱 → [ADR-036](docs/adr/036-portal-app.md) portal → [ADR-076](docs/adr/076-product-maturity-stages-and-blast-radius.md) 제품 단계와 장애 격리
6. [ADR-062](docs/adr/062-production-deployment.md) 단일 호스트 배포 → [ADR-065](docs/adr/065-production-fork.md) 프로덕션 포크 → [ADR-071](docs/adr/071-git-monorepo.md) 모노레포

## 어떻게 만들었나

설계·정책 결정과 검증은 사람이 했고, 구현의 상당 부분은 AI 코딩 에이전트에 위임했다. 그래서 기록이 곧 협업 규율이다.

- 결정은 `docs/adr/`에 남기고, 코드가 ADR과 달라지면 ADR에 날짜 배너를 단다.
- 에이전트에게 준 교정은 `docs/feedback/`에 Rule/Why/How to apply로 남겨 다음 세션이 반복하지 않게 한다.
- 검증은 `docs/test-reports/`의 캠페인 기록과 `bitshuriken-prod-bots`의 정합성 체커가 담당하고, 미해결 버그는 `docs/specs/refactor-observations.md`에 번호로 관리한다.
- 커밋의 `Co-Authored-By` 트레일러는 그 흔적이다.

## 알려진 한계

- 선물은 **beta**다. 정산 프로세스 분리 이후 포지션·잔고 WS 이벤트가 클라이언트에 닿지 않아 폴링에 의존하고, GA 종료 조건과 장애 격리 매트릭스는 [ADR-076](docs/adr/076-product-maturity-stages-and-blast-radius.md) §5·§6에 있다.
- 단일 인스턴스·단일 호스트다. 원장이 프로세스 로컬이라 레플리카가 아니라 샤드로 확장하는 구조이고, HA는 다음 단계다([ADR-069](docs/adr/069-in-memory-balance-ledger.md) §6).
- 미해결 버그 목록은 [refactor-observations.md](docs/specs/refactor-observations.md), 정리 대상 코드는 [2026-09-16 정리 감사](docs/specs/2026-09-16-cleanup-audit.md).

## Monorepo layout

| dir | 역할 | stack |
| --- | --- | --- |
| [bitshuriken-prod-be/](bitshuriken-prod-be/) | 백엔드 API — apps/{spot 5101, futures 5102, portal 5103, settle 5104(정산 프로세스, 헬스 전용)} | Nest.js monorepo + Prisma + Kafka |
| [bitshuriken-prod-fe/](bitshuriken-prod-fe/) | 프론트엔드 (port 5100) | Next.js |
| [bitshuriken-prod-match/](bitshuriken-prod-match/) | 매칭엔진 (Lane 패턴, Kafka) | Python |
| [bitshuriken-prod-infra/](bitshuriken-prod-infra/) | 프로드 배포 (compose + nginx + deploy.sh) | docker |
| [bitshuriken-prod-bots/](bitshuriken-prod-bots/) | Binance/Upbit 미러링·정합성·부하 테스트 | Node.js |
| [bitshuriken-prod-agents/](bitshuriken-prod-agents/) | 백테스트·라이브 전략 실행기 | Node.js |
| [bitshuriken-prod-mcp/](bitshuriken-prod-mcp/) | API 레퍼런스 MCP 서버 (읽기 전용, 개발자 도구) | Node.js |
| [bitshuriken-prod-fly/](bitshuriken-prod-fly/) | 실험: FlyWire 초파리 커넥톰 트레이딩 뇌 (별도 대시보드 :5130) | Node.js |

모든 디렉터리는 하나의 Git 저장소에서 버전 관리한다. 서비스별 의존성·빌드·배포 단위는
그대로 독립적이며, 별도의 루트 workspace 도구는 사용하지 않는다.

## Quickstart (local dev)

```bash
./scripts/exchange.sh start   # 인프라 → BE → 매칭엔진 → FE, 기능 검증 포함
./scripts/exchange.sh status
./scripts/exchange.sh stop
```

최초 1회:

```bash
(cd bitshuriken-prod-be && npm install)
(cd bitshuriken-prod-fe && npm install)
(cd bitshuriken-prod-bots && npm install)
(cd bitshuriken-prod-agents && npm install)
(cd bitshuriken-prod-mcp && npm install && npm run build)
(cd bitshuriken-prod-fly && npm install)   # 실험 프로젝트 — 선택
(cd bitshuriken-prod-match && python3 -m venv venv && venv/bin/pip install -r requirements.txt)
./scripts/exchange.sh reset
```

필요한 서비스는 `.env.example`을 `.env`로 복사해 로컬 값을 설정한다. `.env`와 전략 실행 데이터는
Git에 포함되지 않는다.

### Windows

Windows에서는 **WSL2 + Docker Desktop의 WSL integration** 환경에서 저장소를 WSL 파일시스템에
clone한 뒤 위 Linux 명령을 그대로 실행한다. PowerShell/CMD에서 `exchange.sh`를 직접 실행하는
경로는 지원하지 않는다.

Ubuntu WSL 기준 기본 도구:

```bash
sudo apt update
sudo apt install -y build-essential curl git jq lsof procps python3 python3-venv
```

Node.js 22와 npm은 WSL 내부에 설치하고, Docker Desktop 설정에서 사용하는 WSL 배포판의
integration을 활성화한다.

## Prod deploy

GHCR 이미지 pull 기반 단일 호스트 배포 — [bitshuriken-prod-infra/README.md](bitshuriken-prod-infra/README.md) (ADR-062).

## Docs

- [docs/adr/](docs/adr/) — 아키텍처 의사결정 기록
- [docs/feedback/](docs/feedback/) — 작업 방식 피드백/교정 기록
- [docs/specs/](docs/specs/) — 구현 플랜/관찰 기록
- [docs/test-reports/](docs/test-reports/) — 검증 캠페인 기록(정합성·충실도·TPS)
- [docs/trading/](docs/trading/) — 전략 실행 일지와 실증된 교훈
- 구 프로젝트(options/dex 포함 — mcp는 [ADR-074](docs/adr/074-prod-docs-mcp-server.md)로 복귀)는 `../bitshuriken-v2/`에 아카이브
