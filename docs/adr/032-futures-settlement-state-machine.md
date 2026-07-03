# ADR-032: 선물 정산 — raw fill 이벤트 + 포지션 상태기계 worker

## Status
Accepted

## Context

spot 정산([ADR-014](014-async-settlement-via-event-log.md))은 wallet leg가 순수 delta이기 때문에 성립한다 — 각 이벤트가 잔고에 더할 값을 consume 시점에 확정할 수 있고, worker는 그것을 순서대로 더하기만 하면 된다.

선물은 다르다. EP(가중평균 진입가), RPNL, 마진 해제량이 전부 **적용 시점의 Position 상태의 함수**다. 그런데 taker 주문 1건이 maker N명과 매칭되면 엔진은 TR N개를 수 ms 안에 연속 발행한다. consume 시점(컨트롤러)에서 EP/RPNL을 계산하면 그 기준이 되는 Position row는 100ms 주기 worker가 아직 반영하지 못한 stale EP다 — 두 번째 fill부터 계산이 전부 틀린다. multi-fill은 엣지 케이스가 아니라 선물 체결의 기본 케이스이므로, 이는 가끔 어긋나는 값이 아니라 구조적으로 항상 틀리는 설계가 된다.

따라서 ADR-014가 wallet leg를 "순수 delta만 기록"으로 강제한 것과 같은 원리를 포지션으로 확장해야 한다: 상태 의존 계산은 기록 시점이 아니라 적용 시점에, 상태를 잠근 채로 한다.

## Decision

**consume 시점에는 raw 체결 사실만 SettlementEvent에 저장하고, EP/RPNL/마진 등 포지션 의존 계산은 futures 전용 worker가 apply 시점에 Position 행을 `SELECT FOR UPDATE`로 잠그고 createdAt 순으로 직렬 수행한다.**

### consume — 사실 기록만

- **TR**: Trade insert + SettlementEvent append(kind=FUTURES_TRADE, sourceKey=tradeId)를 한 트랜잭션으로. legs에는 raw 사실만 담는다: symbol, price, qty, maker/taker의 orderId·userId, takerSide, maker/taker fee bps. 파생값(EP, RPNL, 마진 변동)은 담지 않는다.
- **OU**: 주문 status는 동기 update(spot과 동일 — cross-user 충돌 없음). terminal이고 lockedCost > 0이면 FUTURES_REFUND append.
- **멱등**: sourceKey unique + P2002 swallow — ADR-014 메커니즘 그대로.

### apply — futures 전용 worker (포지션 상태기계)

spot worker와 별도의 `futures-settlement.worker`(`@Interval(100)`)가 futures kind만 createdAt 순 직렬 처리한다. FUTURES_TRADE는 maker/taker 각각 Position 행을 SELECT FOR UPDATE로 잠근 단일 트랜잭션에서 전이한다. 전이 규칙(산식 상세는 plan §6):

- **증량** (qty==0 또는 같은 부호): EP 가중평균 갱신, 마진 추가(p×q/lev), 수수료 차감, lockedCost를 체결 비율로 해제. 잔고 부족분은 음수 허용 + error 로그
- **감량** (반대 부호): closeQty만큼 RPNL 실현, 마진 비례 해제(floor), 감량 체결분의 lockedCost도 해제(잠금 고착 금지). 청산 주문이면 청산 수수료를 추가 차감해 보험기금에 적립
- **flip** (감량 초과분): 전량 close 후 초과분을 체결가 EP의 새 포지션으로. 잔고 부족 시 신규분은 보험기금이 즉시 인수(LIQUIDATION_TAKEOVER) + error 로그
- **refund** (FUTURES_REFUND): lockedCost × 미체결 비율을 환불

Order executedQty/cumulativeQuoteQty 누적과 FuturesIncome insert도 같은 apply 트랜잭션에 묶는다.

### 신규 SettlementKind 4종

`FUTURES_TRADE` / `FUTURES_REFUND` / `FUNDING` / `LIQUIDATION_TAKEOVER`. FUNDING은 펀딩 스케줄러가, LIQUIDATION_TAKEOVER는 청산 흐름([ADR-031](031-liquidation-insurance-fund.md))이 생산하며, 적용은 전부 이 worker의 같은 직렬 경로를 지난다.

### spot worker 격리 — 같은 커밋 배포 필수

spot `settlement.worker.ts`에 kind 필터(`kind IN (TRADE, DUST_REFUND)`)와 미지의 leg 타입 throw를 추가하고, **schema의 kind 추가와 같은 커밋으로 배포한다**. 그렇지 않으면 필터 없는 spot worker가 futures 이벤트를 잘못 claim해 wallet leg만 적용하고 APPLIED 처리 — 포지션 delta가 조용히 유실된다.

### FuturesIncome은 apply 시점 insert

REALIZED_PNL/COMMISSION 등 income row는 consume이 아니라 apply 트랜잭션에서 insert한다. RPNL은 잠긴 Position의 EP가 있어야 계산되므로 consume 시점에는 알 수 없는 값이다.

### 수수료 — notional×bps, USDT 차감

요율은 [ADR-025](025-trading-fees.md)의 유저별 bps를 그대로 쓰되 차감 자산이 다르다: spot은 수령 자산에서 차감하지만, 선물은 자산 인수도가 없으므로 `notional × bps`를 USDT 마진 잔고에서 차감한다. Trade.maker/takerCommission에 USDT로 기록 (Trade 모델 무변경).

## Rationale

- consume/apply 분리는 ADR-014에서 검증된 구조다. 선물에서 달라진 점은 "delta가 자명하지 않다"는 것뿐이고, 해법은 delta 확정을 상태 잠금 안으로 옮기는 것이다.
- SELECT FOR UPDATE + createdAt 순 직렬 처리는 multi-fill 정합성의 충분조건이다 — 모든 fill이 직전 fill이 만든 EP를 보고 계산된다.
- legs에 raw 사실만 저장하면 event log가 재계산 가능한 진실 소스로 남는다. 파생값을 저장하면 산식 버그 수정 후 replay가 불가능해진다.
- 잔고 부족 시 음수 허용 + error 로그는 조용한 보정 대신 fail loudly([feedback-014](../feedback/014-fail-loudly.md)).

## Consequences

- 포지션/잔고 가시성에 worker 1 tick(≤100ms) 지연 — ADR-014와 동일한 트레이드오프. 청산 모니터·주문 검증이 보는 Position도 같은 지연을 가진다.
- 단일 worker 직렬 처리라 futures 정산 처리량 상한이 worker 1개에 묶인다 — dev 플랫폼 수준에서 허용, 한계 도달 시 심볼 단위 분할 검토.
- schema kind 추가 + spot worker 필터의 같은 커밋 배포 제약이 생긴다. 이후 새 kind를 추가할 때도 소유 worker를 명시해야 한다 (미지 타입 throw가 가드).
- FUTURES_TRADE 하나가 maker/taker 두 포지션 전이 + Order 누적 + income insert를 한 트랜잭션에 담아 spot보다 트랜잭션이 무겁다 — 정합성 우선의 의도된 선택.
- 정산 상태기계는 Stage 4 단위테스트(plan §12)로 구현 전 가드레일을 깐다: multi-fill EP, 부분 close, flip, refund, sum(qty)==0.

## 관계

- [ADR-014](014-async-settlement-via-event-log.md): event log + worker 정산 구조의 원형 — 본 ADR은 "순수 delta" 원리를 포지션 상태로 확장
- [ADR-025](025-trading-fees.md): 유저별 bps 요율 재사용 — 차감 자산만 수령 자산 → USDT로 변경
- [ADR-028](028-futures-margin-position-model.md): Position/FuturesConfig/FuturesIncome 등 본 ADR이 전이시키는 데이터 모델
- [ADR-031](031-liquidation-insurance-fund.md): LIQUIDATION_TAKEOVER 이벤트의 생산자 — 청산 잔여분 인수가 본 worker에서 적용됨
- [feedback-014](../feedback/014-fail-loudly.md): 부족분 음수 허용 + error 로그 정책의 근거
