# ADR-036: portal 앱 신설 — cross-product 플랫폼 기능의 집

## Status
Accepted

## Context

[ADR-035](035-multi-app-split.md)는 멀티앱 전환 시 cross-product 엔드포인트를 임시 호밍했다: `/auth`·api-key는 spot 앱, `/account/transfers`는 futures 앱. 둘 다 "그 앱의 기능"이 아니라 자리가 없어 얹힌 것이고, ADR-035 §2는 "identity 요구가 분리되는 시점에 세 번째 앱"을 예약해 두었다.

입출금, API key 관리, 커뮤니티, 유저 설정 등 product 무관 기능 요구가 구체화되면서 그 시점이 왔다. transfers는 코드 확인 결과 futures 인메모리 상태에 의존하지 않고 DB만 본다(청산 중 차단도 `Position.status` DB 조회) — 단일 DB([ADR-001](001-single-db-with-market-type.md)) 덕분에 어느 앱에서든 동일 동작하므로 이동 가능.

## Decision

### 1. `apps/portal` 신설 (포트 5103)

```
apps/portal/src/
  main.ts                  ← Kafka consumer/WS 없음 — REST 전용
  portal-app.module.ts
  http/auth/               ← spot에서 이동: /auth/* (signup/login/logout/me), /auth/api-keys
  http/transfers/          ← futures에서 이동: /account/transfers
  (향후) 입출금, 유저 설정(서버 보존분), 커뮤니티, 알림 — 실제 구현 시 추가
```

- **인증 발급은 portal, 검증은 전 앱**: 로그인/세션 쿠키 발급은 portal이 담당하고, spot/futures는 libs/core-domain의 가드·JWT 전략으로 검증만 한다. JWT_SECRET 공유 + 쿠키는 포트 무관이라 추가 장치 불필요.
- spot/futures 앱은 자기 product 기능만 남는다 — [ADR-018](018-product-prefix-and-deployment-options.md)의 외곽 prefix 원칙과 배포 토폴로지가 완전히 일치.
- 빈 기능 선구현 금지([feedback-001](../feedback/001-no-premature-implementation.md)): 본 ADR의 범위는 기존 3개 기능군의 **이동**까지. 입출금 등은 만들 때 추가.

### 2. 포트 체계

| 서비스 | 포트 |
|--|--|
| FE | 5100 |
| spot | 5101 |
| futures | 5102 |
| **portal** | **5103** |
| DB (docker postgres) | 5104 (5103에서 이동 — 앱 연속 번호 확보) |

> **[2026-09-16 현행화]** 포트는 이후 재배정됐다: **settle 5104**([ADR-077](077-settlement-process-split-and-graceful-shutdown.md)), Postgres **5110**, Kafka **5113**(인프라 5110+ 대역, 로컬 5432 충돌 회피). 정본은 `bitshuriken-prod-be/.env.example`과 `scripts/exchange.sh`.

### 3. FE

`portalApi` base(`NEXT_PUBLIC_PORTAL_API_URL`) 추가. auth/api-keys/transfers 호출만 전환. 나머지는 불변.

## Rationale

- **경계 정합성** — "어느 앱에도 속하지 않는 기능"의 자리가 생기면 spot/futures가 순수 product 앱이 되고, 새 cross-product 기능이 생길 때마다 호밍을 고민할 필요가 없다.
- **transfers 이동이 안전** — futures에 두었던 이유(ADR-027)는 마진 검증 접근성이었는데, 실제 구현은 DB 조회뿐이라 그 근거가 소멸했다.
- **portal은 REST 전용** — Kafka consumer도 WS 게이트웨이도 없어 가장 가벼운 앱. 장애 도메인도 분리된다 (포털 다운 = 신규 로그인 불가지만, 기존 세션의 거래는 양 앱에서 계속 동작).

## Consequences

- BE 프로세스 3개. libs 변경은 3개 앱 동시 영향.
- FE 로그인/api-key/transfer 호출이 5103으로 — `NEXT_PUBLIC_PORTAL_API_URL` env 필수(fail loudly).
- DB 포트 5104로 변경 — `.env` DATABASE_URL, docker-compose, up.sh 갱신.
- auth/api-keys e2e는 portal 모듈로, spot trading e2e는 signup을 위해 portal 모듈을 함께 부팅.
- portal 다운 시 로그인·이체·api-key 관리만 불가 — 거래 경로와 독립.

## 관계
- [ADR-035](035-multi-app-split.md): §2의 예약 경로 실행. 임시 호밍 해소
- [ADR-027](027-futures-code-separation-and-deployment.md): transfers의 futures 호밍 근거 소멸 확인
- [ADR-019](019-api-key-with-hmac-signature.md): api-key 발급·관리가 portal로 이동 (HMAC 검증 자체는 libs로 전 앱 공유)
- [ADR-001](001-single-db-with-market-type.md): 단일 DB가 transfers 이동을 가능하게 한 전제
