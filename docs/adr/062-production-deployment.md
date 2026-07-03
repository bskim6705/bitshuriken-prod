# ADR-062: 프로덕션 배포 (단일 호스트 + GHCR + nginx)

> **[bitshuriken-prod fork note, 2026-07-03]** 이 문서는 포크 시점에 현행화됨: dex 프로세스 제거(3 프로세스), 이미지명 `bitshuriken-prod-*`, 레포 `bitshuriken-prod-infra`. 파티션 정책은 ADR-063(FNV-1a 버킷)이 대체.

## Status
Accepted (2026-06-18)

## Context
지금까지 v2는 로컬 dev 스택(루트 `docker-compose.yml` + `scripts/up.sh`)만 있었고 배포 정의가 없었다. 실서비스가 아닌 **시뮬레이션 거래소**를 자가호스팅 머신(구형 Intel Mac mini, Linux, amd64, 16GB)에 올리기로 했다. 배포 대상은 `be`(spot/futures/portal)·`fe`·`match`.

루트 dev compose는 프로덕션 부적합이다: Kafka가 Zookeeper+단일브로커+PLAINTEXT+`advertised=localhost`, Postgres 약한 비번, Mailpit(가짜 메일).

## Decision
1. **빌드는 GitHub Actions(amd64), 호스트는 pull만.** 각 앱 repo가 `release.yml`로 멀티스테이지 이미지를 빌드해 **GHCR**에 push. 호스트는 구형 인텔이라 빌드 부하를 피하고, amd64 러너 = amd64 호스트라 크로스아치 불필요. `bitshuriken-prod-infra` repo의 `docker-compose.prod.yml`이 `:latest`를 pull해 실행.
2. **be = 1 이미지 → 3 프로세스.** `npm run build`(webpack)로 spot/futures/portal을 한 번 빌드, compose에서 `command`만 바꿔 `node dist/apps/<app>/main` 3개 서비스. `prisma`가 prod 의존성이라 같은 이미지로 `be-migrate`(npx prisma migrate deploy) one-shot 실행, 앱은 `service_completed_successfully`로 그 뒤 기동.
3. **nginx 단일 진입점 + Cloudflare + same-origin `/api`.** 환경당 호스트 1개가 FE와 API를 같이 서빙: `<DOMAIN>/`→fe, `<DOMAIN>/api/*`→백엔드. **`/api` prefix는 nginx에서 strip**(regex `^/api(/.*)$` + `proxy_pass http://$u$1`)하므로 앱은 bare 경로(`/spot`, `/auth`, `/ws/market`…) 그대로 — 백엔드/테스트/클라이언트 무변경. WS 게이트웨이(spot `/ws/market`,`/ws/user`·futures `/ws/fmarket`,`/ws/fuser`)도 `/api/ws/*`로 strip 후 라우팅(`map $http_upgrade`). **same-origin이라 CORS 불필요**, `bs_session` 쿠키(SameSite=Lax·host-only·secure=NODE_ENV)가 환경별 자동 격리 — 서브도메인 방식이면 SameSite=None+크로스오리진 쿠키 수술이 필요했다. **TLS는 Cloudflare**(엣지) + **nginx origin이 Cloudflare Origin cert**(`/etc/ssl/cloudflare/origin.{pem,key}`, CF SSL 모드 Full strict) — 초기 Caddy 자동 TLS(Let's Encrypt)에서 전환. 실제 클라이언트 IP는 `CF-Connecting-IP`→`$remote_addr`(real_ip, CF 레인지). 백엔드 upstream은 docker resolver(127.0.0.11)로 요청 시점 재해석(재배포 IP 변경 견딤). DNS는 CF proxied apex 1레코드. nginx만 호스트 포트(80/443) 노출.
4. **Kafka는 KRaft(Zookeeper 제거), 토픽 명시 생성.** `state`/`control`은 log-compacted라 auto-create 비활성. `kafka-init` one-shot이 `match.{spot,futures}.{in,out,book,state,control}`을 `MATCH_*_PARTITIONS`(=버킷 수 P, ADR-063)로 생성.
5. **match는 분리 2 인스턴스.** prod는 `tickers-spot.json`·`tickers-futures.json`으로 `match-spot`·`match-futures` 2개 컨테이너(장애 격리).
6. **fe는 standalone + 빌드타임 주입.** `output: "standalone"`. `NEXT_PUBLIC_*`는 빌드 시 인라인되므로 fe repo의 repository **variables**에서 build-arg로 주입(런타임 주입 불가). 도메인이 바뀌면 fe 재빌드 필요.
7. **메일은 Gmail SMTP.** Mailpit→`smtp.gmail.com:587`(STARTTLS, App Password). secrets·`.env.prod`는 호스트에만, 커밋 금지.
8. **CD 전달은 호스트 pull.** 홈 NAT 뒤라 인바운드 불가 → systemd timer가 `deploy.sh`(`compose pull && up -d`)를 주기 실행. migrate one-shot이 매 `up`마다 idempotent하게 선행.

## Consequences
- 배포 시 호스트 부하는 `docker pull`+컨테이너 재생성뿐(빌드 스파이크 없음). 라이브 서비스가 배포 중에도 안정적.
- `NEXT_PUBLIC_*`가 이미지에 박히므로 fe 이미지는 환경 종속적 — 도메인/플래그 변경 = 재빌드.
- `MATCH_*_PARTITIONS`(버킷 수 P)는 infra·엔진·BE가 **동기 유지** 필요(불일치 시 lane↔partition 매핑 깨짐). ADR-063 참조.
- 시드(자산/admin)는 dev 툴링(ts) 의존이라 최초 1회 수동(`prisma db seed`). 자동화는 후속.
- 프로덕션 하드닝은 경량(강한 시크릿+볼륨+pg_dump 백업) 수준. 실자금 서비스 아님 전제. HA/매니지드 전환은 후속 ADR.
