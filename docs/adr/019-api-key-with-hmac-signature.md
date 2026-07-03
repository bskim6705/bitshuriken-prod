# ADR-019: API key + HMAC signature 인증, JWT와 공존, cross-product `/account/` prefix 도입

## Status
Accepted

## Context

지금까지 인증은 JWT 한 가지였다. 다음 요구가 추가됐다:

- **Open API 호환성**: 외부 클라이언트/SDK가 사용할 수 있는 표준 패턴 필요. Binance/Bybit/OKX 모두 API key + HMAC signature로 통일됨
- **e2e 테스트 단순화**: JWT login flow 없이 seed로 API key 한 개 박아두면 테스트가 한 줄로 호출 가능
- **Bot vs Web 분리**: Web UI는 JWT가 자연스럽지만, bot/SDK는 API key가 표준 기대

또 한 가지: API key는 **user-level cross-product 자산**이다 (한 키로 spot/futures 모두 사용). 현재 모든 endpoint가 `/auth`(public), `/spot/...`(product-scoped) 둘로 나뉘는데, API key 같은 user-level resource는 어디 두는가? `/spot/account/api-keys`로 두면 futures 추가 시 중복.

## Decision

### 1. 인증 방식: API key + HMAC signature, JWT와 공존

Binance Spot API와 동일한 패턴.

**API key (bot, SDK용)** — Binance Spot API와 동일
- 헤더 `X-API-KEY`: public part
- query 파라미터 `timestamp`: epoch ms
- query 파라미터 `signature`: HMAC-SHA256(query_string + body, secret), hex
- query 파라미터 `recvWindow`: 선택. 서버는 `|now - timestamp| > recvWindow` (기본 5000)면 거부
- 자세한 canonical string은 §6 참고

**JWT (web UI용)**
- 기존 유지: `Authorization: Bearer <jwt>`
- signup/login flow 그대로

**Guard 3개, OR composition 패턴**:

- `JwtOnlyGuard` — JWT 검증만 책임
- `ApiKeyOnlyGuard` — API key + signature 검증만 책임
- `PrivateGuard` — 위 둘을 DI로 받아서 header 분기:
  - `X-API-KEY` 헤더 있으면 → `ApiKeyOnlyGuard.canActivate()` 호출
  - `Authorization: Bearer` 있으면 → `JwtOnlyGuard.canActivate()` 호출
  - 둘 다 없으면 → 401

각 단일 가드는 자기 인증 방식만 책임 (단일 책임). `PrivateGuard`는 분기만. 미래에 mTLS, OAuth 등이 추가되면 새 가드 클래스 + `PrivateGuard`에 분기 한 줄 추가.

**용도별 가드 선택**:
- 대부분의 protected endpoint: `PrivateGuard` (둘 다 OK)
- API key 발급/조회/revoke endpoint: `JwtOnlyGuard` (escalation 차단)
- API key 전용 endpoint는 현재 없음 (`ApiKeyOnlyGuard`는 `PrivateGuard`가 내부적으로 사용)

**req.user 통일**: 두 가드 모두 동일한 형태로 `req.user` 채움 → `@CurrentUser()` 데코레이터 일관 동작.
```typescript
{ userId: string, email: string }
```

### 2. Security types (Binance와 동일)

각 endpoint에 다음 중 하나의 security type:

| Type | 인증 요구 | Endpoint 예시 |
|--|--|--|
| `NONE` | 없음 | `GET /spot/market/recent-trades` |
| `USER_DATA` | JWT or (API key + signature, key.canRead 필요) | `GET /spot/account/balances` |
| `TRADE` | JWT or (API key + signature, key.canTrade 필요) | `POST /spot/trading/orders` |

`MARKET_DATA` (key 필요하지만 signature 없음)는 현재 단계에선 도입하지 않음 (Binance도 historicalTrades 한 endpoint만).

### 3. ApiKey 데이터 모델

```prisma
model ApiKey {
  id          String    @id @default(uuid())
  userId      String
  apiKey      String    @unique  // public part. X-API-KEY 헤더에 들어가는 값
  secret      String              // ⚠ Phase 1: plaintext (가드/흐름 검증용). Phase 2에 envelope encryption 필수
  label       String?             // 사용자 별칭
  canTrade    Boolean   @default(false)
  canRead     Boolean   @default(true)
  ipWhitelist String[]  @default([])
  createdAt   DateTime  @default(now())
  lastUsedAt  DateTime?
  revokedAt   DateTime?

  user        User      @relation(fields: [userId], references: [id])

  @@index([userId])
}
```

핵심:
- **HMAC signature 검증의 본질**: 서버는 stored secret을 plaintext로 알아야 HMAC 계산이 가능. bcrypt 같은 단방향 hash는 사용 불가 (서명 검증 ≠ password 검증)
- **Phase 1 (현재)**: secret을 DB에 plaintext로 저장. 가드 / signature 검증 흐름을 먼저 안정화
- **Phase 2 (필수, 별도 작업)**: AES-256-GCM envelope encryption으로 마이그레이션. 환경변수 `API_KEY_ENCRYPTION_KEY` (32 bytes hex) 도입. column 이름도 `secret` → `secretEncrypted`로 정정
- 발급 endpoint 응답에서 한 번만 plaintext 노출 — 사용자에게 보여주는 정책은 Phase 1/2 동일
- `canTrade` 기본 false — 안전 default
- `revokedAt` 필드, 키 조회 시 제외
- `lastUsedAt` async update (정확도 무관)
- `ipWhitelist`는 schema만 두고 enforcement는 후속 작업

**Phase 2 미루는 이유**: secret 저장 보안은 가드 흐름과 직교. Phase 1에서 흐름이 검증되면 envelope encryption은 column 교체 + service 1~2 method 수정만. 미루는 비용 < 한 번에 하는 비용.

**Phase 2 강제 트리거**: 본 ADR은 Phase 2가 끝나기 전에 **production 배포 금지**. README/CLAUDE.md에 명시.

### 4. URL 정책: API key 관리는 `/auth/` 안에 둠

ADR-018의 외곽 prefix 정책에 추가 변경 없음. API key 관리는 인증 자원이므로 `/auth/` 안에 둔다. cross-product `/account/` 같은 새 prefix는 만들지 않는다.

```
/auth/signup, /auth/login                ← public
/auth/api-keys                           ← API key 관리 (JWT 전용)
/spot/account/balances                   ← spot product 안 user data
/spot/account/orders                     ← spot product 안 user data
/spot/account/orders/:id
/spot/account/trades
/spot/trading/orders                     ← spot product action
/spot/market/...                         ← spot public
(미래) /futures/account/balances
(미래) /futures/trading/...
```

분류 규칙:
- **`/auth/`**: 인증 자원. signup, login, **API key 발급/조회/revoke**
- **`/spot/account/`**: spot product 안의 user 자산 (balances, orders, trades)
- **`/spot/trading/`**, **`/spot/market/`**: spot product action

근거: API key는 user의 identity/credential 자원이므로 인증 layer에 속함. Bybit도 `/v5/user/create-sub-api`처럼 user 영역에 두지만, 우리는 sub-account 같은 개념이 없으므로 단순히 `/auth/` 안에 둠. 추가 prefix를 만들지 않아 path 정책이 단순.

### 5. Endpoint

```
POST   /auth/api-keys                ← 키 발급. 응답에 secret plaintext (1회). JWT 전용.
GET    /auth/api-keys                ← 내 키 목록 (secret 없음, label/permission/createdAt만)
DELETE /auth/api-keys/:id            ← revoke (soft delete via revokedAt)
```

**JWT 전용**인 이유: API key로 새 API key를 발급하는 escalation 차단. key 관리는 web UI로만.

### 6. Canonical string 포맷 (signature 대상) — Binance와 동일

```
{query_string}{request_body}
```

- `query_string`: 원래 들어온 그대로 (서버는 sort하지 않고 raw string으로 검증). 클라이언트도 자기가 만든 query를 그대로 사용
- `request_body`: raw bytes (없으면 빈 문자열)
- `timestamp`는 query string에 포함됨 (`?timestamp=1234567890&...`) — 별도 header 아님
- `recvWindow`도 query에 포함 (선택, Binance와 동일)

알고리즘: HMAC-SHA256, hex output. signature는 query string의 `signature` 파라미터로 전달 (또는 `X-API-SIGNATURE` header — 둘 중 하나로 표준화. Binance는 query). 우리는 **query의 `signature` 파라미터** 채택.

서버 검증:
1. query에서 `signature` 분리
2. 남은 query string + body로 HMAC-SHA256 계산
3. `signature`와 비교

Header는 `X-API-KEY` (public key) 하나만. timestamp/signature는 query에.

`recvWindow`: 클라이언트가 query에 명시. 서버는 `|now - timestamp| > recvWindow`면 거부. 기본 5000ms.

## Rationale

- **Binance 호환 signature**: 외부 SDK 사용자가 익숙. 미래 후회 최소화
- **JWT 공존**: 기존 web flow 그대로. 둘이 다른 use case라 통합할 이유 없음
- **`AnyAuthGuard`**: 대부분 endpoint는 둘 다 받음. 호출 측이 자기 방식 선택
- **API key 발급은 JWT 전용**: 키 escalation 차단. 키 분실 시 web UI로 회전
- **`/account/` cross-product prefix**: api-keys, profile 같은 user-level resource는 spot/futures 무관. 별도 prefix가 자연스러움. ADR-018과 직교
- **secret hash 저장**: DB 유출 시 secret 추출 불가. 발급 시점 plaintext 노출은 1회만
- **default `canTrade=false`**: 안전. 사용자가 명시적으로 활성화

## Consequences

- **Schema 변경**: `ApiKey` 모델 추가, `User` 관계 추가, migration 1건. Phase 2에서 `secret` → `secretEncrypted` rename + envelope encryption 마이그레이션 추가
- **Production 금지**: Phase 1 상태로 절대 배포하지 않음. plaintext secret이 DB에 있음
- **신규 모듈**:
  - `domain/api-key/` (ApiKeyService — issue/list/revoke/verify)
  - `http/rest/auth/api-keys/api-keys.controller.ts` 추가 (기존 `http/rest/auth/auth.controller.ts`와 같은 모듈 안)
  - `domain/auth/guards/` 에 `JwtOnlyGuard`, `ApiKeyOnlyGuard`, `PrivateGuard` (composition)
- 기존 `http/rest/spot/account/`, `http/rest/spot/trading/`는 `@UseGuards(AuthGuard('jwt'))` → `@UseGuards(PrivateGuard)`로 교체
- 새 prefix 도입 없음, 폴더 대규모 재배치 없음
- **기존 endpoint 변경**: `/spot/trading/*`, `/spot/account/*`의 `@UseGuards(AuthGuard('jwt'))`를 `AnyAuthGuard`로 교체
- **e2e 테스트**: seed에 API key 한 개 박아두면 fixture 단순화 가능
- **다음 작업 (별도)**:
  - `canTrade` / `canRead` permission enforcement (지금은 schema에만)
  - IP whitelist 검증
  - last-used tracking (async)
  - rate limit per key
  - key rotation flow

## 관계
- [ADR-018](018-product-prefix-and-deployment-options.md): 외곽 prefix 정책. 본 ADR이 cross-product `/account/`를 보강
- 향후 rate limit ADR: API key별 rate limit 분리 시 본 ADR 참조
