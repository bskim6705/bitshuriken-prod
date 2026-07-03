# ADR-030: 펀딩 — 8h premium 산식, zero-sum 보장

## Status
Accepted

## Context

무기한 선물에는 만기가 없어 선물 가격이 현물에서 무한히 이탈할 수 있다. 펀딩은 선물-현물 괴리(premium)에 비례해 롱/숏 한쪽이 반대쪽에 주기적으로 돈을 지불하게 만들어 가격을 인덱스에 묶는 장치다.

제약:
- 펀딩은 유저 간 이전이므로 **시스템 총량이 변하면 안 된다** (zero-sum). 시스템이 돈을 만들거나 잃는 순간 회계가 깨진다.
- mark/index는 [ADR-029](029-mark-price-internal-index.md)의 MarkPriceService가 제공한다 (자체 spot 인덱스, 외부 오라클 없음).
- 잔고 변동은 [ADR-014](014-async-settlement-via-event-log.md)의 SettlementEvent 경유가 원칙 — 펀딩이라고 wallet을 직접 update하는 우회로를 만들지 않는다.

## Decision

**8h 주기 premium 산식 펀딩. 스냅샷 전수 적용 + signed 지급액으로 zero-sum을 구조적으로 보장하고, 라운딩 dust는 보험기금이 흡수한다.**

### 1. 주기와 이자율은 코드 상수

- 주기 8h, 정산 시각 UTC 00/08/16. `@Cron('0 0 0,8,16 * * *', { timeZone: 'UTC' })` — **timeZone 명시 필수**, 기본값은 서버 로컬 타임존이라 배포 환경에 따라 정산 시각이 흔들린다.
- 이자율 0.01%/8h 코드 상수.
- 둘 다 **DB 필드 금지**. 동적 주기는 MVP 범위 외고, 쓰지 않는 설정 필드는 죽은 필드가 된다 ([feedback-008](../feedback/008-no-future-proofing.md)). 심볼별로 실제 달라지는 값(`fundingCap`)만 FuturesConfig(DB)에 둔다.

### 2. Rate 산식 (Binance 방식 축약)

- premium 샘플: 1분 @Cron으로 `P = (mark − index) / index` 적립.
- 정산 시: `F = avgP + clamp(0.01% − avgP, ±0.05%)` → `clamp(F, ±fundingCap)`.
- 샘플 0개(부팅 직후)면 `F = clamp(0.01%, ±fundingCap)`.
- 샘플은 심볼별 **in-memory ring** — 재시작 시 부분 윈도우를 허용한다. 1분 샘플을 DB에 영속화할 가치가 dev 플랫폼에서는 없고, 부분 윈도우여도 rate가 cap 안에서 약간 다르게 나올 뿐 회계는 깨지지 않는다.

### 3. 지급액 — signed 한 줄로 zero-sum

```
payment = −F × mark × qty   (qty는 signed: +롱 / −숏)
```

F>0이면 롱(qty>0)은 음수=지불, 숏(qty<0)은 양수=수령. 롱/숏 분기 없이 부호가 방향을 결정하므로, 심볼별 `sum(qty) == 0` invariant가 유지되는 한 지급 총합도 0이다.

### 4. 스냅샷은 qty≠0 전부 — LIQUIDATING 포함

- 정산 시점에 `qty != 0`인 포지션 **전부**를 스냅샷한다. `LIQUIDATING` 상태도, 보험기금 포지션도 제외하지 않는다.
- 어느 한 포지션이라도 스킵하면 그 반대편 포지션의 펀딩 상대가 사라져 매 펀딩마다 시스템이 돈을 만들거나 잃는다. zero-sum은 전수 적용일 때만 성립한다.

### 5. 라운딩 — 지급 floor, 차감 ceil, dust는 보험기금

- 유저 수령액은 floor, 유저 차감액은 ceil (유저에게 유리한 방향 금지).
- floor/ceil로 생기는 잔여 dust는 보험기금 leg로 귀속 — 라운딩 후에도 정산 이벤트 내 총합 0을 유지한다.

### 6. 차감 폭포

차감 시 balance가 부족하면 부족분을 `isolatedMargin`에서 차감하고 marginRatio 재평가를 플래그한다 (margin이 깎여 청산 조건에 들어갈 수 있음 — [ADR-031](031-liquidation-insurance-fund.md)의 모니터가 처리).

### 7. 정산 경로와 멱등

- 흐름: rate 산출 → `FundingRate` insert → 스냅샷 → 유저별 `SettlementEvent(kind=FUNDING)` append. 실제 잔고 반영은 futures settlement worker가 apply ([ADR-014](014-async-settlement-via-event-log.md) 유지) + `FuturesIncome(FUNDING_FEE)` 기록.
- sourceKey = `funding:{sym}:{ts}:{userId}` — 스케줄러가 중복 발화해도 unique 제약으로 멱등.

## Rationale

- **zero-sum을 산식 구조로 보장** — "지급 합계가 0인지 검증"하는 사후 체크가 아니라, signed 단일 산식 + 전수 스냅샷 + dust 귀속으로 합이 0일 수밖에 없게 만든다. 검증은 단위 테스트(라운딩 dust 포함 zero-sum)로 못 박는다.
- **코드 상수 vs DB의 경계** — 운영 중 바뀔 수 있는 심볼별 도메인 값(fundingCap)은 DB, 바뀔 계획이 없는 정책(주기·이자율)은 코드. env는 deployment-variant 전용이라 후보가 아니다.
- **SettlementEvent 경유** — 펀딩만 wallet 직접 update하면 정산 경로가 둘이 되고, 멱등성/장애 복구 의미론을 따로 발명해야 한다. 기존 event log에 kind 하나 추가하는 쪽이 일관적이다.

## Consequences

- 스케줄러 재시작 시 premium 윈도우가 부분적일 수 있다 — rate가 약간 달라질 뿐 회계 영향 없음 (문서화로 충분).
- LIQUIDATING 포지션도 펀딩을 내므로, 청산 진행 중 margin이 추가로 깎일 수 있다 — 차감 폭포와 재평가가 이를 흡수한다.
- 보험기금 포지션도 펀딩 대상이므로 기금 잔고가 펀딩으로 변동한다. 기금 포지션 정리는 수동 운영 ([ADR-031](031-liquidation-insurance-fund.md)).
- 동적 펀딩 주기·심볼별 이자율이 필요해지면 그때 코드 상수를 DB로 옮긴다 — 비파괴적 추가라 미리 만들 이유가 없다.

## 관계
- [ADR-014](014-async-settlement-via-event-log.md): 펀딩 정산도 SettlementEvent(FUNDING) append → worker apply 경로를 따름
- [ADR-029](029-mark-price-internal-index.md): premium의 mark/index 출처. 1분 샘플 적립도 MarkPriceService가 수행
- [ADR-031](031-liquidation-insurance-fund.md): 차감 폭포 후 marginRatio 재평가, LIQUIDATING 포지션 펀딩 포함
- [feedback-008](../feedback/008-no-future-proofing.md): 주기/이자율을 DB 필드로 만들지 않는 근거
- [feedback-015](../feedback/015-domain-data-from-db.md): fundingCap이 DB(FuturesConfig)에 있는 근거
