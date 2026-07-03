# ADR-028: 선물 마진/포지션 모델 — isolated 전용 + one-way

## Status
Accepted

## Context

USDT-margined 무기한 선물 MVP에 마진 모드, 포지션 모드, 주문 자금 검증의 위치를 결정해야 한다.

제약:
- 매칭엔진은 마진·잔고 개념이 없다 ([ADR-002](002-single-matching-engine-with-market-type-branch.md)의 분기 원칙 — 매칭 코어는 가격-시간 우선순위만, 자금 처리는 전후 처리). 엔진 무수정이 전제.
- 폐쇄계 dev 플랫폼 — 외부 오라클 없이 자체 spot 인덱스 기반 mark를 쓴다. 가격 조작이 같은 시스템 안에서 가능하므로 자금 유출 공격면을 접수단에서 막아야 한다.
- 단일 개발자 MVP — cross 마진, 헤지 모드, 레버리지 브래킷은 범위 밖.

## Decision

1. **Isolated 전용.** cross 마진 없음. 포지션마다 `isolatedMargin`이 닫힌 회계 단위이며, 손실 책임은 해당 포지션의 마진까지로 한정된다.
2. **One-way.** user+symbol당 포지션 1개, `qty`는 signed(+롱/−숏). 헤지 모드 없음.
3. **포지션 보유 중 레버리지 변경 금지** (`qty == 0`일 때만 허용). 대신 `PATCH /futures/trading/positions/:symbol`에 `{leverage} XOR {marginDelta}`로 **마진 수동 증감(marginDelta)** 을 제공한다. `+`는 balance→isolatedMargin(가용 검증), `−`는 잔여 마진 ≥ mark notional/lev 검증.
4. **주문 cost** = IM + openLoss + taker 수수료 예약:
   - `cost = notional/lev + openLoss + notional × takerBps/10000` (세부 산식은 plan §3)
   - openLoss = mark 대비 불리한 가격의 즉시 손실분 (BUY: `max(0, p−m)×q`, SELL: 반대)
   - reduceOnly·liquidation 주문은 cost = 0 (잠금 없음)
5. **MARKET 가정가 버퍼.** MARKET은 체결가를 모르므로 `ap = m × (1 ± marketCostBufferPct)` 기준으로 notional·IM·openLoss를 계산해 잠근다.
6. **LIMIT 가격 밴드.** 주문가 p가 `[m×(1−priceBandPct), m×(1+priceBandPct)]` 밖이면 400 거부.
7. **lockedCost를 Order row에 저장.** cost는 접수 시점 mark(MARKET은 가정가)에 의존하므로 사후 재계산이 불가능하다. 체결 시 비례 해제, terminal 시 잔여 환불의 기준값.
8. **마진 검증·잠금은 BE 접수단의 동기 트랜잭션.** balance→locked 이동과 `Order.lockedCost` 기록을 마치고 NO를 발행한다. 엔진은 마진을 모르는 채로 유지(ADR-002).
9. **reduceOnly의 flip은 접수단에서 거부** — reduceOnly 주문은 `Σ(해당 심볼 reduceOnly open qty) + 신규 qty ≤ |position qty|` 합산 검증으로 포지션 초과를 막는다. 일반 주문은 전체 qty의 cost를 잠그므로 flip이 허용되며, 접수와 체결 사이 포지션 변동까지 포함해 정산단에 flip 처리 규칙이 존재한다 (상세는 [ADR-032](032-futures-settlement-state-machine.md)).
10. **파생값(청산가 LP, UPNL, marginRatio)은 저장하지 않는다.** Position에는 원천값(qty, entryPrice, isolatedMargin, leverage)만 두고 매번 mark에서 유도한다.

## Rationale

- **cross 제외**: cross에서는 청산가가 계정 잔고와 타 포지션 UPNL에 상호 의존한다 — 한 포지션의 체결이 모든 포지션의 청산 판정을 흔들고, 회계가 계정 단위로 결합된다. isolated는 포지션 행 하나만 잠그면 정산·청산 판정이 끝나는 닫힌 회계라 정산 상태기계와 청산 모니터가 단순해진다.
- **hedge 제외**: signed qty 하나로 포지션 표현이 끝난다. 롱/숏 동시 보유는 MVP에 필요 없는 복잡도.
- **레버리지 변경 금지 + marginDelta**: 보유 중 레버리지를 바꾸면 기존 포지션 IM 재산정과 증거금 추가/해제를 원자적으로 풀어야 한다. 유저가 실제로 원하는 효과(청산가 조정)는 marginDelta 직접 증감이 더 단순한 산식으로 동일하게 제공한다.
- **가격 밴드 — 자전거래 자금 유출 공격 차단**: 공격자가 계정 2개로 반대 포지션을 만든 뒤 mark에서 극단적으로 떨어진 가격에 자전거래로 감량 체결하면, 한쪽은 isolatedMargin을 한참 초과하는 RPNL 손실(isolated라 책임은 마진까지, 결손은 시스템 부담)을, 반대쪽은 거울 이익을 실현해 출금한다 — 순효과는 거래소 자금 유출. openLoss 예약은 신규 진입의 즉시 손실만 잠글 뿐, 기존 포지션 감량 RPNL은 접수 시점에 알 수 없으므로 가격 자체를 mark ± priceBandPct로 제한해 1회 체결로 이전 가능한 PnL에 상한을 둔다.
- **MARKET 가정가 버퍼**: MARKET은 mark보다 불리하게 체결될 수 있는데 잠금이 mark 기준이면 부족분이 생긴다. 버퍼만큼 보수적으로 잠그고 실체결 후 차액은 정산단에서 해제.
- **lockedCost 박제**: 해제·환불이 "접수 때 얼마를 잠갔는가"에 정확히 대응해야 잔여 잠금 고착(dust lock)이 없다. mark는 1초마다 변하므로 저장 외에 방법이 없다.
- **BE 접수단 동기 잠금**: 검증 없이 NO를 보내면 미자금 주문이 체결된다. 엔진에 마진을 가르치는 것은 ADR-002 위반이고, 접수단 동기 잠금은 spot과 동일한 패턴이라 추가 인프라가 없다. 주문 mutation 자체는 여전히 NO/CO로 엔진을 경유한다 ([feedback-002](../feedback/002-order-mutations-via-matching-engine.md)).
- **파생값 비저장**: mark가 1s tick으로 갱신되므로 저장하는 순간 stale이다. 원천값에서 항상 유도 가능한 값을 컬럼으로 만들면 모든 변경 지점에 동기화 의무만 생긴다 ([feedback-008](../feedback/008-no-future-proofing.md)).

## Consequences

- Position 모델이 `@@id([userId, tickerSymbol])` + signed qty로 단순해진다. cross/hedge를 후속 도입하면 모델 확장(positionSide 등)이 필요하다 — 의도된 비용.
- 주문 접수가 mark에 의존한다. index 부재(부팅 직후 spot 체결 0건) 시 `getMark()` throw로 주문 자체가 불가 — fail loudly.
- 가격 밴드 때문에 정상 유저의 deep limit 주문(mark에서 priceBandPct 초과 이탈)도 거부된다. MVP에서 수용.
- 레버리지를 바꾸려면 포지션을 닫아야 한다.
- lockedCost의 비례 해제·환불·flip 처리 규칙이 정산 상태기계에 결합된다 — 상세는 [ADR-032](032-futures-settlement-state-machine.md).
- `Order`에 `reduceOnly`, `liquidation`, `lockedCost` 컬럼이 additive로 추가된다. 단일 Order 테이블 정책([ADR-015](015-single-order-table-with-partial-index.md))은 유지.

## 관계

- [ADR-002](002-single-matching-engine-with-market-type-branch.md): 엔진은 마진을 모른다 — 본 ADR이 마진 책임을 BE 접수단으로 확정하며 이 원칙을 유지
- [ADR-015](015-single-order-table-with-partial-index.md): 단일 Order 테이블에 futures 컬럼 additive 추가
- [ADR-032](032-futures-settlement-state-machine.md): lockedCost 해제/환불/flip의 정산단 처리 상세
- [feedback-002](../feedback/002-order-mutations-via-matching-engine.md): 주문 mutation은 엔진 경유 — 마진 잠금은 접수단 책임이되 주문 흐름은 NO/CO 그대로
- [feedback-008](../feedback/008-no-future-proofing.md): 파생값 컬럼을 만들지 않는 근거
