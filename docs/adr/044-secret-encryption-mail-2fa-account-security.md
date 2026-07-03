# ADR-044: API key secret 봉투 암호화(ADR-019 Phase 2) + 메일 인프라 + 2FA/이메일 인증/비밀번호 재설정

## Status
Accepted

## Context

ADR-019는 API key secret을 plaintext로 저장하고(Phase 1) Phase 2(envelope encryption)가 끝나기 전 **production 배포를 금지**했다. 또한 거래소 보안의 기본인 2FA·이메일 인증·비밀번호 재설정이 전무했고, 이를 받칠 메일 인프라가 아예 없었다. 이 ADR이 그 블로커들을 해소한다.

## Decision

### 1. API key secret 봉투 암호화 (ADR-019 Phase 2)
- `EncryptionService` (AES-256-GCM, `libs/core-domain/src/crypto`). 키는 env `API_KEY_ENCRYPTION_KEY`(32바이트 hex) — 부재/형식오류면 부팅 실패. 출력 `ivHex:tagHex:ciphertextHex`, IV는 매 호출 랜덤.
- schema `ApiKey.secret` → `secretEncrypted`. `issue` 시 암호화 저장(평문 secret은 발급 응답 1회만), `verifySignature` 시 복호화하여 HMAC 계산.
- 같은 `EncryptionService`가 TOTP secret 저장에도 사용.

### 2. 메일 인프라
- `MailService` (nodemailer SMTP, `libs/core-domain/src/mail`). env: `SMTP_HOST`/`SMTP_PORT`/`MAIL_FROM`/`APP_BASE_URL` 필수(+선택 `SMTP_USER`/`SMTP_PASS`/`SMTP_SECURE`). 부재 시 부팅 실패. 로컬은 인증 없는 dev SMTP(Mailpit/Mailhog) 사용.
- 메일 링크는 `APP_BASE_URL/verify-email?token=` · `/reset-password?token=`.

### 3. 2FA (TOTP)
- `TotpService`(otplib v12 `authenticator`, ±1 step 허용) + `TwoFactorService`(setup→enable→disable, 강제 검사). secret은 암호문으로 저장, enable 전까지 보류분. 관리 endpoint는 **JWT 전용**(API key로 2FA 토글하는 escalation 차단).
- **opt-in**: 2FA를 켠 유저에게만, **로그인 + 출금 + API키 발급**에서 코드 강제. 끈 유저는 no-op → 기존 흐름/테스트 불변.
- 로그인은 단일 단계: 코드 없으면 `TWO_FACTOR_REQUIRED`(60010) 반환 → FE가 코드 필드 노출 후 재요청.

### 4. 이메일 인증 / 비밀번호 재설정
- `AuthToken` 모델(EMAIL_VERIFY/PASSWORD_RESET). raw 토큰은 메일로만, DB엔 **sha256 해시**만. 일회성 소비(usedAt) + 만료(verify 24h, reset 1h).
- **이메일 인증 강제**: 가입은 미인증 상태로 자동 로그인(데모 흐름 보존), **출금만** 인증 필수. 거래/로그인은 미인증도 허용.
- **비밀번호 재설정**: `forgot`는 계정 존재 여부 무관 항상 일반 200(enumeration 방지). `reset`은 토큰 소비 후 비번 교체. `change`는 현재 비번 확인(웹 세션 전용).
- signup의 인증 메일 발송은 best-effort(실패해도 가입 진행, 재발송 endpoint 제공).

## Rationale
- HMAC 검증은 secret 원문이 필요 → 단방향 해시 불가, 대칭 암호화(AES-256-GCM)가 정답. GCM auth tag로 변조 탐지.
- 2FA opt-in + 단일 단계 로그인은 기존 세션/테스트를 깨지 않으면서 Binance식 게이팅을 제공.
- 토큰 해시 저장 + enumeration 방지는 표준 계정 탈취 방어. 출금만 이메일 인증 강제는 데모 UX와 안전성의 균형.

## Consequences
- **Schema**: `secret`→`secretEncrypted`(rename), `User`에 emailVerified/twoFactorEnabled/twoFactorSecret, `AuthToken` 모델 + enum. 마이그레이션 1건(대기 중인 marginMode/FundingTx와 함께 적용).
- **신규 env(필수)**: `API_KEY_ENCRYPTION_KEY`(전 앱), `SMTP_HOST/SMTP_PORT/MAIL_FROM/APP_BASE_URL`(portal). 부재 시 부팅 실패 — `.env`에 추가 필요.
- **의존성**: nodemailer, otplib@12, qrcode(+types).
- **마이그레이션 시 기존 dev API key 무효화**: secret 컬럼 교체로 기존 키는 재발급 필요(평문이었으므로 어차피 폐기 대상).
- **테스트**: 단위 222/222(crypto/totp/2fa 신규 spec 포함). e2e는 위 env + SMTP(dev Mailpit) 필요.
- **명시적 범위 밖(후속)**: API 레이트리밋, 로그인 lockout/brute-force, IP whitelist 강제, key expiry, 세션/디바이스 관리, change-password의 2FA 게이팅.

## 관계
- [ADR-019](019-api-key-with-hmac-signature.md): Phase 1 plaintext → 본 ADR이 Phase 2 봉투 암호화 완료
- [ADR-043](043-api-scope-enforcement-and-funding-ledger.md): API key scope/withdraw 게이팅 — 본 ADR의 2FA·이메일 인증이 출금 게이트에 추가됨
