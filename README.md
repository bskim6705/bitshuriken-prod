# Bitshuriken

현물과 USDT 무기한선물 거래를 지원하는 시뮬레이션 거래소입니다.
주문 접수부터 매칭, 체결, 잔고 정산까지 구현하고 있으며, 자체 매칭엔진에서 거래 전략과 봇을 실행하고 검증하는 것을 목표로 개발하고 있습니다.

Binance·Upbit의 실시간 호가를 미러링하는 봇과 주문·체결·잔고를 대조하는 검증 도구를 함께 제공합니다.

## 주요 기능

- **현물·선물 거래:** 지정가·시장가 주문, 주문 취소, 부분 체결과 잔량 처리. 선물은 마진·포지션·펀딩·청산 기능을 포함합니다.
- **매칭엔진:** 가격·시간 우선으로 주문을 처리하며, 주문장 스냅샷과 Kafka 메시지를 이용해 중단 후 상태를 복원합니다.
- **잔고·정산:** 주문 접수 시 가용 잔고를 확인하고 예약합니다. 체결 결과는 이벤트로 기록해 별도 정산 프로세스에서 반영합니다.
- **거래 화면:** 차트·주문장·체결 내역과 계정 관리 화면을 제공하며, WebSocket으로 시장 데이터를 전달합니다.
- **전략 테스트:** 시장 데이터 미러링, 부하 생성, 정합성 검사, 백테스트와 라이브 전략 실행 도구를 포함합니다.

## 현재 상태와 한계

프로젝트 내 제품 단계는 현물·계정 기능 GA, 선물 beta로 구분합니다. 이는 시뮬레이션 서비스의 개발 단계이며, 거래소 전체의 고가용성을 보장한다는 의미는 아닙니다.

- 현재 배포는 단일 호스트를 기준으로 합니다. 잔고 원장이 프로세스 메모리에 있어 API 인스턴스를 단순히 늘리는 방식의 확장은 지원하지 않습니다.
- 매칭엔진의 스냅샷 복원과 메시지 재처리를 구현했지만, 대기 서버로 자동 전환하는 HA 구성은 아직 없습니다.
- 정산 프로세스 분리 이후 일부 잔고·포지션 변경 알림은 WebSocket으로 전달되지 않아 클라이언트가 주기적으로 조회합니다.
- 현물과 선물은 프로세스와 토픽을 구분하지만, 공유 정산 프로세스 등 아직 장애가 서로 영향을 줄 수 있는 지점이 남아 있습니다.

세부 내용은 [제품 단계와 장애 격리](docs/adr/076-product-maturity-stages-and-blast-radius.md), [정산 프로세스 분리](docs/adr/077-settlement-process-split-and-graceful-shutdown.md), [알려진 문제](docs/specs/refactor-observations.md)에 정리되어 있습니다.

## 설계 전제

구형 Intel Mac mini에 Linux를 설치해 자가 호스팅하는 환경을 기준으로 설계했습니다. 듀얼코어 CPU와 HDD의 자원 제약을 고려해, 서비스와 파티션을 심볼 수만큼 늘리는 대신 제한된 자원 안에서 거래를 처리하는 구성을 선택했습니다.

### 여러 심볼이 하나의 파티션을 공유

초기에는 심볼마다 전용 Kafka 파티션을 배정했지만, 심볼이 늘어날수록 파티션 수와 HDD I/O·복구 부담이 커졌습니다. 현재는 심볼 해시로 정해진 수의 파티션에 배정합니다. 기본값은 시장별 토픽당 6개이며, 여러 심볼이 같은 파티션을 공유합니다.

심볼별 전용 파티션을 두지 않을 뿐, 동일 심볼의 주문과 취소는 여전히 같은 파티션으로 전달해 처리 순서를 유지합니다. 대신 같은 파티션에 배정된 심볼들은 처리 자원을 공유하므로, 특정 심볼의 부하가 다른 심볼의 처리 지연에 영향을 줄 수 있습니다. 배경과 복구 방식은 [파티션 구성 결정](docs/adr/063-match-partition-buckets-and-stw.md)에 정리했습니다.

### 공유 파티션의 심볼별 재처리

주문장 스냅샷에는 심볼별 마지막 처리 오프셋을 저장합니다. 복구할 때는 같은 파티션을 공유하는 심볼 중 가장 이른 복구 지점(`last_offset + 1`)부터 메시지를 읽고, 각 심볼의 스냅샷에 이미 반영된 메시지는 건너뜁니다. Kafka에서 읽는 위치는 파티션 단위지만, 실제 재처리 여부는 심볼별로 판단합니다.

스냅샷이 없는 심볼은 빈 주문장으로 시작하며, 부팅 시점 이전 메시지를 건너뜁니다. 따라서 스냅샷이 없는 주문장까지 과거 입력 전체로 복구하는 방식은 아닙니다. 재처리에 필요한 메시지가 Kafka에 보존되어 있어야 복구할 수 있습니다.

### Redis를 사용하지 않는 이유

현재 구성에서는 Redis를 도입할 계획이 없습니다. 잔고 확인·예약 등 빈번한 처리에 별도 저장소와의 왕복 통신(RTT)을 추가하지 않도록 프로세스 내부의 상태를 사용하고, 복구에 필요한 기록은 PostgreSQL과 Kafka에 남깁니다. Redis를 사용했던 이전 버전과는 다른 선택입니다.

이 선택은 단일 호스트와 제한된 자원을 전제로 합니다. 프로세스 간 상태 공유와 수평 확장이 단순해지는 것은 아니며, 향후 배포 구조가 바뀌면 상태 소유권과 공유 방식도 다시 검토해야 합니다.

## 구조

백엔드는 현물·선물·계정 API와 정산 프로세스로 나뉩니다. 거래 API와 Python 매칭엔진은 Kafka로 주문과 체결 결과를 주고받습니다.

신규 주문과 취소는 같은 입력 토픽을 사용하며, 동일 심볼의 메시지는 같은 파티션에서 순서대로 처리합니다. 엔진은 가격·수량을 `10^8` 배 정수로 계산하고, 서비스 사이에서는 문자열로 전달해 정밀도를 유지합니다.

주문장은 스냅샷과 이후 입력 메시지로 복원합니다. 체결 ID는 주문 ID를 기준으로 생성해 재처리 후에도 유지하며, 정산에서는 고유 이벤트 키로 중복 반영을 방지합니다. 잔고 원장은 별도로 저장한 변경 이력을 재처리해 복원하고, 조회용 DB 잔고는 비동기로 갱신합니다.

| 디렉터리 | 역할 | 주요 기술 |
| --- | --- | --- |
| [bitshuriken-prod-be/](bitshuriken-prod-be/) | 현물·선물·계정 API, 정산 | NestJS, Prisma, PostgreSQL, Kafka |
| [bitshuriken-prod-fe/](bitshuriken-prod-fe/) | 거래 화면과 계정 관리 | Next.js, React |
| [bitshuriken-prod-match/](bitshuriken-prod-match/) | 매칭엔진, 주문장 복구 | Python, Kafka |
| [bitshuriken-prod-infra/](bitshuriken-prod-infra/) | 배포 구성 | Docker Compose, Nginx |
| [bitshuriken-prod-bots/](bitshuriken-prod-bots/) | 시장 미러링, 정합성 검사, 부하 테스트 | Node.js |
| [bitshuriken-prod-agents/](bitshuriken-prod-agents/) | 백테스트, 라이브 전략 실행 | Node.js |
| [bitshuriken-prod-mcp/](bitshuriken-prod-mcp/) | API 문서 조회용 MCP 서버 | Node.js |
| [bitshuriken-prod-fly/](bitshuriken-prod-fly/) | FlyWire 커넥톰 기반 트레이딩 실험 | Node.js |

하나의 Git 저장소에서 관리하며, 의존성 설치와 빌드는 서비스별로 진행합니다. 루트에 별도의 workspace 도구는 사용하지 않습니다.

## 로컬 실행

Node.js 22, npm, Python 3.12, Docker와 Docker Compose가 필요합니다. 실행 스크립트는 Bash 환경을 기준으로 합니다.

### 설치와 환경 설정

```bash
(cd bitshuriken-prod-be && npm install)
(cd bitshuriken-prod-fe && npm install)
(cd bitshuriken-prod-bots && npm install)
(cd bitshuriken-prod-agents && npm install)
(cd bitshuriken-prod-match && python3 -m venv venv && venv/bin/pip install -r requirements.txt)
```

MCP 서버와 트레이딩 실험은 필요한 경우에 설치합니다.

```bash
(cd bitshuriken-prod-mcp && npm install && npm run build)
(cd bitshuriken-prod-fly && npm install)
```

사용할 서비스의 `.env.example`을 `.env`로 복사하고 로컬 환경에 맞게 설정합니다. `.env`와 전략 실행 데이터는 Git에 포함하지 않습니다.

새 로컬 환경에서는 다음 명령으로 DB와 Kafka를 초기화합니다. **기존 환경에서 실행하면 Docker 볼륨의 데이터가 삭제되므로, 데이터를 보존해야 할 때는 실행하지 마세요.**

```bash
./scripts/exchange.sh reset
```

### 시작과 종료

```bash
./scripts/exchange.sh start
./scripts/exchange.sh status
./scripts/exchange.sh stop
```

`start`는 인프라, 백엔드, 매칭엔진, 프론트엔드를 순서대로 시작하고 상태를 확인합니다.

| 서비스 | 기본 포트 |
| --- | --- |
| 프론트엔드 | 5100 |
| 현물 API | 5101 |
| 선물 API | 5102 |
| 계정 API | 5103 |
| 정산 상태 확인 | 5104 |

### Windows

WSL2와 Docker Desktop의 WSL integration을 사용합니다. 저장소를 WSL 파일시스템에 복제한 뒤 위 명령을 실행하세요. PowerShell이나 CMD에서 실행 스크립트를 직접 호출하는 방식은 지원하지 않습니다.

Ubuntu WSL에서 필요한 기본 도구는 다음과 같습니다.

```bash
sudo apt update
sudo apt install -y build-essential curl git jq lsof procps python3 python3-venv
```

Node.js와 npm도 WSL 내부에 설치하고, Docker Desktop에서 해당 WSL 배포판의 integration을 활성화합니다.

## 테스트

백엔드와 매칭엔진의 단위·회귀 테스트는 각 디렉터리에서 실행합니다.

```bash
(cd bitshuriken-prod-be && npm test)
(cd bitshuriken-prod-match && venv/bin/python -m pytest -q)
```

[CI](.github/workflows/ci.yml)에서는 백엔드 테스트와 타입 검사, 프론트엔드 타입 검사와 린트, 매칭엔진 테스트, 봇·전략 실행기의 타입 검사를 수행합니다. DB·Kafka를 사용하는 통합 검증과 부하 테스트는 별도로 실행합니다.

장애 복구와 부하 테스트 결과는 실행 조건과 함께 [검증 기록](docs/test-reports/)에 남깁니다. 개별 테스트 결과를 서비스 전체의 처리량이나 무중단 보장으로 사용하지 않습니다.

## 배포

GHCR에 게시한 이미지를 받아 단일 호스트에서 실행하는 구성을 제공합니다. 환경 설정과 배포 절차는 [배포 문서](bitshuriken-prod-infra/README.md)를 참고하세요.

## v2에서의 포크

이 저장소는 `bitshuriken-v2`에서 현물·선물 거래소 코어를 중심으로 분리한 프로젝트입니다. 포크 당시 options·DEX는 코어에서 제외했고, bots·agents는 외부 API를 사용하는 전략 테스트 서비스로 포함했습니다. MCP 서버는 이후 API 문서 조회용 개발 도구로 다시 추가했습니다.

이전 구현과 설계 배경은 로컬의 `../bitshuriken-v2/`에서 참고할 수 있습니다. v2는 읽기 전용 아카이브이며, 현재 개발과 수정은 이 저장소에서 진행합니다. 이전 코드를 참고할 때는 현재 코드와 서비스별 `AGENTS.md`, 후속 ADR을 함께 확인하세요.

- [프로덕션 포크 배경](docs/adr/065-production-fork.md)
- [단일 Git 저장소로 통합](docs/adr/071-git-monorepo.md)
- [MCP 서버 재도입](docs/adr/074-prod-docs-mcp-server.md)

## 설계와 개발 기록

주요 설계 결정은 다음 문서에서 확인할 수 있습니다.

- 주문 처리: [심볼별 처리 구조](docs/adr/013-match-engine-lane-architecture.md), [Kafka 파티션 구성](docs/adr/063-match-partition-buckets-and-stw.md)
- 장애 복구: [주문장 복구](docs/adr/034-match-engine-state-recovery.md), [재처리 시 체결 ID 유지](docs/adr/038-deterministic-trade-id.md)
- 잔고·정산: [비동기 정산](docs/adr/014-async-settlement-via-event-log.md), [실패 이벤트 격리](docs/adr/067-settlement-dead-letter-queue.md), [인메모리 원장](docs/adr/069-in-memory-balance-ledger.md), [정산 프로세스 분리](docs/adr/077-settlement-process-split-and-graceful-shutdown.md)
- 선물: [마진·포지션](docs/adr/028-futures-margin-position-model.md), [마크 가격](docs/adr/029-mark-price-internal-index.md), [청산·보험기금](docs/adr/031-liquidation-insurance-fund.md)

이 밖의 [설계 기록](docs/adr/), [구현 계획과 알려진 문제](docs/specs/), [테스트 결과](docs/test-reports/), [전략 실행 기록](docs/trading/), [개발 과정의 피드백](docs/feedback/)도 저장소에서 관리합니다. 과거 결정이 변경된 경우에는 해당 문서의 후속 기록을 함께 확인하세요.
