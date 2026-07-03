# ADR-039: Cross 마진 — per-position 토글 + 계정 단위 일괄 청산

## Status
Accepted (2026-06-14)

## Context

[ADR-028](028-futures-margin-position-model.md)은 MVP를 **isolated 전용**으로 확정하며 cross를
제외했다. 사유: cross는 청산가가 계정 잔고와 타 포지션 UPNL에 상호 의존해 회계가 계정 단위로
결합된다. 이제 운영자가 cross를 요구해 추가한다 — isolated는 그대로 두고 **per-position 토글**로
공존시킨다(Binance식: 심볼별로 유저가 모드 선택).

제약은 ADR-028과 동일: 매칭엔진 무수정, 외부 오라클 없는 폐쇄계 mark, 단일 개발자 MVP.

## Decision

1. **per-position 마진 모드.** `Position.marginMode ∈ {ISOLATED, CROSS}`, 기본 ISOLATED.
   `PATCH /futures/trading/positions/:symbol`에 `{marginMode}` 추가 — leverage와 동일하게
   **qty==0일 때만** 변경. cross에는 `marginDelta` 거부(마진은 지갑 잔고에서 자동).
2. **cross는 isolated의 IM 예약·정산 기계를 그대로 재사용.** cross 포지션도 주문 cost(IM+openLoss
   +fee)를 `locked`에 잠그고 체결 시 IM을 `isolatedMargin`에 적립한다. 즉 `isolatedMargin`은 두
   모드 공통의 "포지션 예약 마진"으로 의미가 확장된다. 정산 상태기계([ADR-032](032-futures-settlement-state-machine.md))는
   **무변경** — 증량/감량/flip/refund/takeover가 모드와 무관하게 동일하게 적용된다.
3. **cross 담보·청산 판정은 계정 단위.** 유저의 모든 cross 포지션(전 심볼)을 묶어:
   - `crossEquity = freeBalance + Σ_cross(isolatedMargin + UPNL)`
   - `crossMM = Σ_cross(mmr × mark × |qty|)`
   - 판정: `crossEquity ≤ crossMM` (= ratio `crossMM/crossEquity ≥ 1`), 또는 `crossEquity ≤ 0`이면 즉시 대상.
   `freeBalance`는 FUTURES USDT 지갑의 free `balance`. `locked`(미체결 주문 예약분)은 **제외** — 보수적
   (큰 cross 미체결이 청산을 앞당김). isolated 포지션·마진은 cross 판정에서 완전히 분리된다.
4. **cross 청산은 계정 전체 일괄.** 판정 시 유저의 `qty≠0` cross 포지션을 **전부**(전 심볼) guarded
   claim으로 `LIQUIDATING` 전이 → 각 심볼의 cross open 주문 CO → 각 심볼 잔여 qty IOC MARKET 청산 →
   잔존분은 보험기금이 BP로 인수 → 전부 NORMAL 복귀. isolated의 "전량 청산, 부분 없음"과 일관되며
   부분/순차 청산은 도입하지 않는다.
5. **cross 청산 중 신규 주문 차단(계정 단위).** 유저에게 `LIQUIDATING` cross 포지션이 하나라도 있으면
   신규 주문 전부 거부(전 심볼) — 청산 진행 중 새 노출 진입을 막는다. isolated는 기존대로 심볼 단위 차단.
6. **파생값 표시.** cross 포지션은 계정 단위 marginRatio를 공유 표시하고, 청산가는 타 포지션을
   상수로 둔 **추정가**: `effectiveMargin_i = isolatedMargin_i + freeBalance + Σ_{j≠i}(IM_j+UPNL_j−MM_j)`를
   기존 `liquidationPrice`에 넣어 유도. ADR-028 §10의 "파생값 비저장" 유지.

## Rationale

- **isolated 정산 재사용** — cross의 본질 차이는 *유지증거금의 출처와 청산 판정 범위*뿐이다. IM 예약·EP
  가중평균·RPNL·flip은 모드와 무관하다. 정산 기계를 분기 없이 그대로 쓰면 가장 검증된 코드를 재사용하고
  cross 고유 버그면을 청산 판정 한 곳으로 좁힌다(ADR-017의 "검증된 뒤에만 공통 추출"과 반대 방향 —
  여기서는 *분기를 만들지 않는 것*이 단순).
- **freeBalance를 cross 담보로** — isolated는 자기 `isolatedMargin`까지만 책임지는 닫힌 풀이고, cross는
  지갑 free 잔고를 공유 담보로 끌어쓴다. 한 cross 포지션의 손실이 다른 cross 포지션의 이익·free 잔고로
  상계되는 것이 cross의 정의이며, `crossEquity` 식이 정확히 이를 표현한다.
- **locked 제외(보수적)** — `locked`를 모드별로 쪼개 추적하려면 Order에 marginMode를 달아야 한다. MVP는
  `locked`를 cross equity에서 빼는 단순·보수적 규칙을 택한다(청산을 늦추지 않음 → 지급여력 안전). 미체결을
  많이 건 cross 계정이 다소 일찍 청산될 수 있음은 수용한다.
- **계정 일괄 청산** — 부분/순차 청산은 청산가·집행 로직이 포지션 간 상호의존으로 복잡해진다. isolated가
  이미 "전량 청산"이므로 cross도 계정 전체를 한 번에 닫는 것이 정책적으로 일관되고 단순하다.
- **추정 청산가** — cross 청산가는 계정 전체에 의존해 단일 포지션으로 정의되지 않는다. 타 포지션을 현재
  mark로 고정하면 isolated와 동형의 닫힌 식이 되어 `liquidationPrice`를 재사용할 수 있다(Binance의 추정
  청산가와 동일한 의미).

## Consequences

- 청산 모니터가 두 경로로 갈린다: isolated(단일 Position 행 판정, 기존) + cross(유저별 다중 행 + 지갑
  조회로 계정 판정). cross는 심볼 tick에서 트리거되지만 평가/집행은 유저의 전 심볼을 본다 — 동시 처리
  방지용 per-user busy 락 추가.
- `Position.marginMode` 컬럼이 additive로 추가된다. 기존 행/신규 행 기본 ISOLATED라 기존 동작 불변.
- cross 청산 중 신규 주문 차단이 계정 단위라, 다른 심볼 cross 진입도 함께 막힌다(의도된 안전 차단).
- locked 제외로 cross 청산 임계가 보수적이다. 정확한 모드별 locked 분리는 Order.marginMode 도입 시 후속.
- cross 잔여 인수도 isolated와 동일한 per-심볼 BP takeover를 쓴다 — 심볼별 `sum(Position.qty)==0` 보존.
  cross의 결손은 BP와 시장가 차이로 보험기금이 흡수(ADR-031과 동일 흐름).
- 정산 상태기계·엔진·Kafka 컨트랙트 무변경. 변경은 BE 접수단/청산 모니터/표시 + 스키마 1컬럼 + FE 토글.

## 관계
- [ADR-028](028-futures-margin-position-model.md): isolated 전용 결정을 본 ADR이 per-position 토글로 확장(§1 supersede)
- [ADR-031](031-liquidation-insurance-fund.md): 청산 집행·BP 인수 패턴 — cross는 계정 단위로 확장 적용
- [ADR-032](032-futures-settlement-state-machine.md): 정산 상태기계 무변경 재사용
- [feedback-016](../feedback/016-policy-decisions-ask-user.md): 마진 모드·청산 정책은 유저 결정 — 본 ADR의 선택지 확정 경위
