# ADR-045: 일별 순자산 스냅샷(Estimated Balance) + 통합 변동내역

## Status
Accepted

## Context

유저가 (a) 월간 **자산가치 추이 차트**와 (c) **통합 "전체 자산 변동내역"**을 원했다. 핵심은 이게 서로 다른 두 질문이라는 점:

- **Flow(변동내역)**: "무슨 일이 있었나" — 이산 이벤트(입출금·체결·수수료·손익). 가격 불필요.
- **State(순자산 추이)**: "X일에 내 자산가치는?" — 이벤트가 없어도 **가격 따라 드리프트**(보유만 해도 평가액 변동). 가격 필요.

둘은 같은 테이블로 못 합친다. per-user balance를 고빈도 cron 폴링하는 건 안티패턴이지만, **일별 1회 스냅샷은 표준**(Binance `accountSnapshot`).

## Decision

### 1. 일별 순자산 스냅샷 (Binance Estimated Balance 대응)
- `BalanceSnapshot {userId, day, totalUsdt, spotUsdt, futuresUsdt, breakdown(Json)}` — 유저·일별 1행.
- **writer = futures 앱** (`@Cron('0 0 * * *', UTC)` + 부팅 시 1회 시드). 이유: **mark price가 futures 앱 메모리에만** 있음(`MarkPriceService`, DB 미보관). portal은 가격 접근 불가.
- 평가 합성식(Binance 구성): `spot 보유(free+locked) × spot last 체결가 + futures 지갑 + Σ 오픈 포지션 uPnL(mark)`. 스테이블=1, mark 미정의면 uPnL 0. **spot/futures 분리 + per-asset breakdown** 저장 → 총액(섞어서)·마켓별(각각) 둘 다 표현.
- **read = portal** `GET /account/net-worth?from=&to=` — 저장된 totalUsdt를 그대로 반환(읽을 때 가격 재계산 없음). READ scope(API 키 OK).
- **derive(원장×글로벌가격) 방식은 채택 안 함** — 일별 스냅샷이 더 단순하고 **정산 워커 무수술**. 인트라데이/감사용 derive는 후속 옵션.

### 2. 통합 변동내역 ("섞어서") — 도메인별("각각")과 공존
- `GET /account/history?type=&asset=&startTime=&endTime=&limit=` (portal) — `FundingTx`(입출금/이체) + `FuturesIncome`(손익/펀딩/수수료) + `Trade`(체결)를 **조회 시 UNION** + 시간순. `type` 미지정=섞어서(All), 지정=해당 도메인만(각각). **정산 워커 무수술**(쓰기 경로 추가 없음, 읽기 전용 머지).
- 기존 도메인별 엔드포인트(`/account/transactions`, `/futures/account/income`, 주문·체결 history)는 그대로 유지 — Binance도 flow는 도메인별로 둠.

## Rationale
- **flow ≠ state.** Binance도 flow는 per-domain 엔드포인트, state는 `accountSnapshot`(일별 materialize, `totalAssetOfBtc` 박아둠)로 분리. 본 ADR이 같은 구조.
- per-user **일별** 스냅샷은 비용이 활동량이 아닌 유저수에 비례하지만 1일 1회라 무해. derive 대비 단순성·무수술이 이 프로젝트엔 더 큰 이득.
- writer가 futures 앱인 건 markPrice 메모리 제약의 결과 — 계정 스냅샷이 cross-product임에도 데이터가 거기 있어서.

## Consequences
- **Schema**: `BalanceSnapshot` 모델 + `User.balanceSnapshots`. 마이그레이션 1건(이미 대기 중인 누적분에 추가 — 한 번의 `migrate dev`로 전부 적용).
- **부팅 시드**: futures 앱 기동 시 1회 스냅샷 → 차트가 즉시 한 점. 단 부팅 직후 mark가 cold면 uPnL 0(다음 일별 보정).
- **전진 누적**: 과거 가격을 보관한 적 없으므로 곡선은 **배포 시점부터** 쌓인다.
- **테스트**: `valueUser` 순수 평가 단위테스트(227 그린).
- **후속(범위 밖)**: live 현재가 점(읽기 시점 평가), 인트라데이 스냅샷, derive 기반 감사, self-trade 행의 양면 표현.

## 관계
- [ADR-043](043-api-scope-enforcement-and-funding-ledger.md): FundingTx 원장 — 통합 변동내역의 한 소스
- [ADR-039](039-cross-margin-per-position-toggle.md): 포지션/마진 — uPnL 평가에 사용
