# bitshuriken-prod-infra

Bitshuriken 프로덕션 배포 — 단일 Linux 호스트(amd64). 이미지는 각 앱 레포의 GitHub Actions가 GHCR에 push, 호스트는 pull만 (ADR-062). (시스템 개요는 상위 `../CLAUDE.md`.)

## 파일
- `docker-compose.prod.yml` — **코어 스택만**: postgres, kafka(KRaft), kafka-init, be-migrate, be-{spot,futures,portal,settle}(1 이미지 4 프로세스 — settle은 정산 티어, 엔진보다 먼저 기동), match-{spot,futures}, fe, nginx.
- 이미지 빌드는 모노레포 루트 `.github/workflows/release-{be,fe,match}.yml`(서비스 디렉터리 path 필터). 서비스 하위 `.github/`는 GitHub이 읽지 않는다.
- `nginx/bitshuriken.conf` — same-origin `/api` 라우팅(`/api/spot|futures|ws → 해당 앱, 나머지 → portal`, `/ → fe`). server_name `bitshuriken.com`. TLS = Cloudflare Origin cert.
- `deploy.sh` — `compose pull && up -d --remove-orphans` (+ prune). `scripts/kafka-init.sh` — 토픽 생성. `scripts/admin-ticker.mjs` — 티커 운영 CLI.
- `.env.prod.example` — 프로드 env 템플릿 (호스트의 `.env.prod`로 복사, 커밋 금지).

## 절대 바꾸지 말 것 (데이터/연속성)
- DB 이름/유저 (`DATABASE_URL`), compose 프로젝트명 `bitshuriken-prod`, 볼륨 `pgdata`/`kafkadata`, 네트워크 `bitshuriken_internal`.
- Kafka 토픽명 `match.*`, consumer group id, `state`/`control` 토픽. (오프셋·엔진 복구 상태가 볼륨에 산다.)
- `JWT_SECRET`, 세션 쿠키명, TOTP issuer, GHCR owner `bskim6705`, Prisma 마이그레이션 폴더/바이트.

## 규칙
- infra compose는 **코어 제품만** — 보조 서비스(추후 봇 등)를 여기 욱여넣지 않는다. 각 서비스는 자기 배포 정의를 소유하고 `bitshuriken_internal`에 external로 붙는다 (docs/feedback/023).
- `.env.prod`에는 **백엔드 + 진짜 공유 인프라 값만** (DB·도메인·시크릿). 다른 서비스 설정을 섞지 않는다 (docs/feedback/022).
- `MATCH_*_PARTITIONS`(버킷 수 P)는 엔진·BE와 동기 유지 (ADR-063).
- 이미지: `ghcr.io/bskim6705/bitshuriken-prod-{be,match,fe}:latest`.

## 검증 / 배포
```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod config   # 렌더 확인(프로젝트명/볼륨)
./deploy.sh                                                              # 호스트에서 pull + up
```
be-migrate(prisma migrate deploy)와 kafka-init이 앱 기동 전 선행. 배포 런북 상세는 `README.md`. ADR/피드백은 상위 `../docs/`.
