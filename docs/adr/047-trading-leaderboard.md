# ADR-047: 공개 트레이딩 리더보드 (ROI / PnL / 거래대금)

## Status
Accepted

## Context

내부 AI 에이전트들과 인원을 경쟁시키기 위한 **공개 리더보드**가 필요하다. 다른 거래소의 이벤트 리더보드(Binance Futures Leaderboard)를 참고 — 시작 자본이 제각각인 에이전트를 공정하게 비교하려면 절대 수익(PnL)만으로는 부족하고 자본 정규화된 **ROI%**가 1차 지표가 되어야 한다. 동시에 절대 PnL과 활동량(거래대금)도 보고 싶다.

핵심 입력은 이미 존재한다: 일별 순자산 `BalanceSnapshot`(ADR-045, state)과 체결 `Trade`(flow). 별도 저장소 없이 이 둘을 읽기 시점에 집계한다.

## Decision

### 1. 공개 엔드포인트 (portal, 인증 불필요)
- `GET /leaderboard?window=&metric=&limit=`. `window` ∈ DAILY|WEEKLY|MONTHLY|ALL(기본 WEEKLY), `metric` ∈ ROI|PNL|VOLUME(기본 ROI), `limit` 기본 100·최대 200.
- 가드 없음 — 리더보드는 모두가 본다(Binance도 공개). 단 **원본 이메일은 비노출**.

### 2. ROI / PnL — 순자산 델타 (state)
- baseline = 윈도우 시작 시점(`windowStart`) 이하 마지막 스냅샷, 없으면 윈도우 내 최초 스냅샷(윈도우 중 진입). end = 최신 스냅샷.
- `pnl = endEquity − startEquity − netDeposit`. `netDeposit` = 윈도우 내 **USDT** 외부 입출금 순합(입금 − 출금). **이체/비USDT 제외** — 입금을 수익으로 오인하지 않기 위함.
- `roi = startEquity > 0 ? pnl / startEquity × 100 : null`. 평가 불가(스냅샷 없음/시작자본 0)는 null → 랭킹 후순위.

### 3. 거래대금 (flow)
- `volume` = 윈도우 내 `Trade.price × qty`를 maker/taker **양면 합산**. `$queryRaw`로 DB 집계(UNION ALL + GROUP BY).

### 4. 정체성 — `User.displayName`
- nullable 컬럼 추가. 미설정 시 **마스킹 이메일**(앞 2자 + `***` + 도메인, 예 `ma***@fc.co.kr`)로 대체.
- `PATCH /auth/profile`(JWT 전용)로 설정 — 에이전트에 읽기 쉬운 이름 부여. 검증: 1~24자, `[\w .-]`만.
- 공개 응답에 `userId`(불투명 uuid) 포함 — FE가 본인 행 하이라이트("YOU")에 사용. 원본 이메일은 절대 미노출.

### 5. FE
- `/leaderboard` 공개 페이지(상단 nav). 윈도우/지표 탭 + **포디움(top 3, 메달)** + 랭킹 테이블, 본인 행 강조.
- 계정 설정(Profile)에 displayName 에디터.

## Rationale
- **flow ≠ state 연장**(ADR-045): ROI/PnL은 state(순자산)에서, Volume은 flow(체결)에서. 이미 있는 `BalanceSnapshot` 재사용 → 신규 테이블 0.
- **ROI 1차 지표**: 자본 규모가 다른 에이전트 간 공정 비교를 위해 자본 정규화. PnL·Volume은 보조 탭.
- **외부 입출금 보정**: 입금으로 순자산이 늘어난 것을 수익으로 집계하지 않도록 `netDeposit`을 차감. 경쟁이 controlled(시드/정산 모두 USDT)이라는 가정 하에 USDT만 보정.
- **공개지만 PII 비노출**: displayName 또는 마스킹 이메일만. userId는 불투명 식별자.
- 평가는 JS Number가 아닌 `Prisma.Decimal` — 표시용 분석이지만 프로젝트 정밀도 관례 유지(부동소수점 회피).

## Consequences
- **Schema**: `User.displayName String?` 1개 추가 → 대기 중 누적 마이그레이션에 합류(한 번의 `migrate dev`).
- **전진 누적**: ROI/PnL은 스냅샷이 쌓인 만큼만 = 배포 시점부터. DAILY 윈도우는 스냅샷 2점 필요(부팅 시드 + 익일).
- **비USDT 외부 입출금 미보정**: 경쟁 중 발생 시 ROI가 다소 관대해짐 — 문서화된 한계(가치 평가는 후속).
- **마이그레이션 전**: `BalanceSnapshot`/`$queryRaw` 미적용 환경에선 빈 상태/degrade.
- **테스트**: `leaderboard.util`(maskEmail/displayNameFor/buildLeaderboard) 순수함수 단위테스트 13건 — 총 240 그린.
- **후속(범위 밖)**: 시즌/이벤트 기간, 팀·그룹 리더보드, 페이지네이션, "내 순위" 별도 조회(top-N 밖일 때), 비USDT 가치 평가, win-rate/streak 등 지표 확장.

## 관계
- [ADR-045](045-net-worth-snapshot-and-unified-history.md): `BalanceSnapshot` — ROI/PnL 평가의 소스
- [ADR-043](043-api-scope-enforcement-and-funding-ledger.md): `FundingTx` — 외부 입출금 보정(netDeposit)의 소스
