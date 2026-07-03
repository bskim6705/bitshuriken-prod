# bitshuriken-prod

Bitshuriken — spot·futures 시뮬레이션 거래소, 프로덕션 워크스페이스.
`bitshuriken-v2`의 시맨틱 포크로, spot/futures/portal 코어만 남기고 정제했다
(경위: [docs/adr/065](docs/adr/065-production-fork.md)).

## Repos

| dir | 역할 | stack |
| --- | --- | --- |
| [bitshuriken-prod-be/](bitshuriken-prod-be/) | 백엔드 API — apps/{spot 5101, futures 5102, portal 5103} | Nest.js monorepo + Prisma + Kafka |
| [bitshuriken-prod-fe/](bitshuriken-prod-fe/) | 프론트엔드 (port 5100) | Next.js |
| [bitshuriken-prod-match/](bitshuriken-prod-match/) | 매칭엔진 (Lane 패턴, Kafka) | Python |
| [bitshuriken-prod-infra/](bitshuriken-prod-infra/) | 프로드 배포 (compose + nginx + deploy.sh) | docker |

이 우산 레포는 docs(ADR/feedback/specs)·dev 인프라(docker-compose.yml)·스크립트를 버전 관리한다.
서브레포 4개는 각자 독립 git 레포(gitignore 처리).

## Quickstart (local dev)

```bash
docker compose up -d          # postgres :5110, kafka :5113 등
./scripts/up.sh               # BE 3앱 + match + FE 일괄 기동 (Ctrl-C로 종료)
```

최초 1회 (fresh DB):
```bash
cd bitshuriken-prod-be
npm install && npx prisma migrate dev --name init && npx prisma db seed
```

## Prod deploy

GHCR 이미지 pull 기반 단일 호스트 배포 — [bitshuriken-prod-infra/README.md](bitshuriken-prod-infra/README.md) (ADR-062).

## Docs

- [docs/adr/](docs/adr/) — 아키텍처 의사결정 기록 (001~065, 일부 결번은 드롭된 기능)
- [docs/feedback/](docs/feedback/) — 작업 방식 피드백/교정 기록
- [docs/specs/](docs/specs/) — 구현 플랜/관찰 기록
- 구 프로젝트(options/dex/bots/agents/mcp 포함)는 `../bitshuriken-v2/`에 아카이브
