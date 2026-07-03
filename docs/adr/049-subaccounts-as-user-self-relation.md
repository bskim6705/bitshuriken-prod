# ADR-049: 서브계정 — User 자기참조 모델 + 계정 간 이체

> **[bitshuriken-prod fork note, 2026-07-03]** 서브계정 기능 자체는 이 포크에서 활성 유지한다(API 트레이딩용). 동기 부분에 등장하는 트레이딩 에이전트(`bitshuriken-v2-agents`)는 포함되지 않는다.

## Status
Accepted (2026-06-15)

## Context
에이전트는 API로만 거래해야 하므로, 사람 로그인과 분리된 격리 거래 계정과 그 계정에 자금을 넣고 빼는 수단이 필요하다. 단일 `User`가 지갑·주문·API키·이체·포지션을 모두 소유하는 현 구조에서 서브계정을 어떻게 표현할지 결정한다.

5개 서브시스템(인증/지갑/API키/이체/스키마)을 매핑한 결과, `userId` FK가 10곳(Wallet, Order, Position, ApiKey, FundingTx, OrderList, AuthToken, BalanceSnapshot, FuturesIncome, Trade maker/taker)에 퍼져 있다.

## Decision (정책은 유저 확정)
1. **모델**: 서브계정 = `User` 자기참조. `User.parentUserId String?` 추가 — null이면 마스터/일반, 설정 시 서브계정. 별도 Subaccount 엔티티(B안)는 모든 FK가 User/Subaccount union을 가리켜야 해 거부.
2. **인증**: 서브계정은 **로그인 없음**. 합성 email(`sub.{rand}@subaccount.local`) + 사용 불가 password 해시(아무도 모르는 무작위 → `bcrypt.compare` 항상 실패)로 로그인 차단. 마스터가 생성하고 서브계정용 API 키를 발급. 에이전트는 그 키(HMAC)로만 접근.
3. **내부 이체**: 마스터↔서브 + 서브↔서브. 같은 마스터 소속 두 계정 간, 같은 마켓(SPOT 기본) 이동.
4. **외부 입출금**: 마스터만. 서브계정은 내부 이체로만 자금 수급.

### 핵심 귀결 — 격리가 공짜
서브계정 API 키로 인증하면 `req.user.userId` = 서브계정 id가 되어, 기존 per-user 로직(지갑/주문/정산/포지션)이 **가드·정산 전파 수정 없이** 그대로 격리 동작한다. 이것이 A안을 택한 결정적 이유.

### 스키마 변경 (additive-only)
- `User.parentUserId String?` + 자기관계(`parent`/`subaccounts`) + `@@index([parentUserId])`
- `FundingTx.counterpartyUserId String?` — 계정 간 이체 상대
- `FundingTxType.SUBACCOUNT_TRANSFER` 추가

### 이체 원장
`SUBACCOUNT_TRANSFER`는 양측에 1행씩 기록(보낸 쪽 `fromMarket`만, 받은 쪽 `toMarket`만 설정해 방향 표시; `counterpartyUserId`로 상대 식별). 그래서 `/account/transactions`·`/account/history`에 양 계정 모두 표시된다. FUTURES 이체 시 양측 `FuturesIncome(TRANSFER)`도 기록(보낸 −, 받은 +). FUTURES를 보낼 때는 기존 transfers와 동일한 출금 게이트(청산 중 포지션/PENDING 정산 차단)를 적용 — 머니 세이프티 로직이라 ADR-017에 따라 복제.

### 엔드포인트 (portal, 세션 전용)
`POST/GET /subaccounts`, `GET /subaccounts/{id}/balances`, `POST/GET/DELETE /subaccounts/{id}/api-keys[/{keyId}]`, `POST /subaccounts/transfers`. 관리 API는 JWT 전용(api-keys와 동일) — API 키로 서브계정·키를 만드는 escalation 차단. 서브계정 키 발급은 **마스터**의 2FA로 보호.

### 기타 정책
- 수수료: 생성 시 마스터의 `feeMakerBps/feeTakerBps` 상속(스냅샷).
- 크로스 마진 담보: 서브계정은 자체 지갑 → 담보 격리(풀링 없음). A안에서 자동.
- 리더보드: 서브계정(`parentUserId != null`) 공개 랭킹 제외.
- 라벨: 서브계정의 `displayName`을 라벨로 재사용(리더보드 제외라 노출 안 됨).
- 한도: 마스터당 `MAX_SUBACCOUNTS = 100`.

## 범위 밖
- 계정 간 직접 cross-market 이체(예: 마스터 SPOT → 서브 FUTURES 한 번에). 같은 마켓 계정 간 이체 + 계정 내 `/account/transfers` 조합으로 달성. 필요 시 additive 확장.
- 서브계정 자체 KYC/2FA/이메일 인증(로그인 없음 → 불필요).

## Consequences
- 마이그레이션 additive-only(컬럼 추가, 기존 행 변경 없음). 유저가 `prisma migrate dev` 1회 실행 필요.
- 새 ErrorCode 그룹(90000번대): `SUBACCOUNT_NOT_FOUND/LIMIT_REACHED/NESTING_FORBIDDEN`. 에러 카탈로그 문서 자동 반영.
- 서브계정은 거래/스냅샷을 정상 생성 → 마스터가 잔고·순자산 조회 가능, 단 리더보드엔 미노출.

## 관계
- [ADR-017](017-product-split-inside-trading-only.md): 출금 게이트 복제 허용 근거
- [ADR-044](044-secret-encryption-mail-2fa-account-security.md): API 키 암호화·2FA — 서브계정 키도 동일 경로
- [ADR-045](045-net-worth-snapshot-and-unified-history.md): 통합 변동내역 — SUBACCOUNT_TRANSFER 부호 처리 추가
- [ADR-047](047-trading-leaderboard.md): 리더보드 — 서브계정 제외
