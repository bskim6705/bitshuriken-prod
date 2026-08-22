# bitshuriken-prod

Bitshuriken — spot·futures 시뮬레이션 거래소 모노레포.
`bitshuriken-v2`의 시맨틱 포크로, 거래소 코어는 spot/futures/portal에 집중하고
bots/agents는 외부 사용자 표면을 사용하는 전략 테스트 서비스로 함께 둔다
(경위: [ADR-065](docs/adr/065-production-fork.md), [ADR-071](docs/adr/071-git-monorepo.md)).

## Monorepo layout

| dir | 역할 | stack |
| --- | --- | --- |
| [bitshuriken-prod-be/](bitshuriken-prod-be/) | 백엔드 API — apps/{spot 5101, futures 5102, portal 5103} | Nest.js monorepo + Prisma + Kafka |
| [bitshuriken-prod-fe/](bitshuriken-prod-fe/) | 프론트엔드 (port 5100) | Next.js |
| [bitshuriken-prod-match/](bitshuriken-prod-match/) | 매칭엔진 (Lane 패턴, Kafka) | Python |
| [bitshuriken-prod-infra/](bitshuriken-prod-infra/) | 프로드 배포 (compose + nginx + deploy.sh) | docker |
| [bitshuriken-prod-bots/](bitshuriken-prod-bots/) | Binance/Upbit 미러링·정합성·부하 테스트 | Node.js |
| [bitshuriken-prod-agents/](bitshuriken-prod-agents/) | 백테스트·라이브 전략 실행기 | Node.js |

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
- 구 프로젝트(options/dex/mcp 포함)는 `../bitshuriken-v2/`에 아카이브
