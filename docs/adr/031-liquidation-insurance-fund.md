# ADR-031: 청산은 BE LiquidationMonitor + 잔여 결손은 보험기금이 포지션 인수

## Status
Accepted

## Context

Isolated 마진 선물에서 마진이 유지증거금 아래로 내려간 포지션은 강제 청산되어야 한다. 제약:
- 매칭엔진은 수정 불가. 엔진은 포지션/마진/mark price 개념이 없고 inbound op는 `NO`/`CO`뿐이다.
- 청산 IOC MARKET이 전량 체결된다는 보장이 없다 — 호가가 얇으면 잔여 qty가 남고, 이를 방치하면 심볼별 `sum(Position.qty) == 0` invariant가 깨진다.
- 청산 시점의 잔여 마진은 파산가까지의 손실을 덮지 못할 수 있다 — 결손을 흡수할 주체가 필요하다.
- MVP 범위: 부분 청산·ADL·레버리지 브래킷 없음 (단일 MMR).

## Decision

**청산 판정·집행은 BE LiquidationMonitor(futures 프로세스 전용)가 담당하고, IOC 미체결 잔여는 보험기금이 파산가로 포지션을 실제 인수한다.**

1. **판정**: mark tick(1s)마다 `qty != 0 AND status = NORMAL` 포지션을 DB에서 단순 조회. 트리거 조건은
   `marginRatio = MM / (isolatedMargin + UPNL) ≥ 1` (분모 ≤ 0이면 즉시 청산 대상).
   인메모리 캐시 없음 — DB 조회가 곧 판정.
2. **claim**: guarded claim으로 `NORMAL → LIQUIDATING` 전이 — `updateMany(where: {userId, tickerSymbol, status: NORMAL})`, 1건 갱신 실패 시 skip. [ADR-021](021-stop-orders-be-trigger.md) 트리거 서비스와 동일 패턴으로 중복 청산을 단일 지점에서 차단. **claim 직후 최신 mark로 건전성을 재평가**해 그 사이 회복된 포지션은 NORMAL 복귀(건전 포지션의 open 주문 취소 방지).
3. **차단**: LIQUIDATING 동안 해당 user+symbol의 신규 주문, leverage/margin 변경(positions PATCH), 해당 유저의 futures→spot transfer-out을 거부.
4. **집행 흐름**: 해당 user+symbol open 주문(비청산 주문) 전부 CO 발행 → Order rows가 전부 terminal이 될 때까지 poll(타임아웃 시 error 로그 + 중단·재시도) → in-flight 청산 주문이 있으면 terminal까지 추적(중복 NO 방지) → PENDING futures 정산 drain 후 **건전성 재재평가**(in-flight 체결로 회복됐으면 NORMAL 복귀) → 잔여 `Position.qty`로 **일반 IOC MARKET NO 발행** (`liquidation=true`, `lockedCost=0`, 유저 명의; emit 실패 시 해당 주문 REJECTED 전이 후 재시도). 새 Kafka op 없음 — 엔진은 청산 여부를 모르고, 주문 mutation은 엔진 경유 원칙([feedback-002](../feedback/002-order-mutations-via-matching-engine.md))을 지킨다.
5. **전량 청산**: 부분 청산 없음 — Binance의 단계적 부분 청산과 다른 정책임을 명시한다.
6. **잔여 인수**: IOC terminal + 정산 apply 후에도 qty가 남으면 보험기금이 **파산가(BP)** 로 Position 행을 인수(LIQUIDATION_TAKEOVER) — 유저 포지션 qty 0/margin 0, 잔여 마진은 기금 balance로, 기금 Position에 BP 기준 EP 가중평균 합산. 이후 status NORMAL 복귀.
   - 롱: `BP = EP − margin/Q`, 숏: `BP = EP + margin/Q`
7. **청산 수수료**: liquidation 주문의 감량 체결분에 `liquidationFeeRate`를 적용해 보험기금 balance에 적립(income LIQUIDATION_FEE). 거래 수수료 소각 정책([ADR-025](025-trading-fees.md))과 구분되는 별도 흐름.
8. **보험기금 실체**: seed로 생성하는 시스템 유저(email 코드 상수) + FUTURES USDT wallet. 기금 포지션은 청산 모니터에서 제외(fund userId 비교)하되 펀딩 정산에는 포함하고, 정리는 수동 운영. 기금 balance 음수 허용 — ADL은 연기.

## Rationale

- **엔진 무수정 제약 하의 유일한 구조** — 트리거 판정을 코어 밖에서 하는 ADR-021과 같은 결론. mark price를 아는 곳(BE)이 판정해야 한다.
- **캐시 없는 DB 조회** — MVP 규모(포지션 수십~수백 행, 1s tick)에서 인메모리 캐시는 성능 이득 없이 DB와의 정합성 리스크만 추가한다. 진실은 Position 행 하나.
- **포지션 인수가 현금 정산보다 우월** — 잔여 qty를 현금으로만 정산하면 그 qty의 반대편 포지션이 시장에 남아 `sum(qty) == 0`이 깨지고, 이후 펀딩(zero-sum)과 UPNL 회계가 영구히 어긋난다. 기금이 포지션을 실제로 떠안아야 회계가 닫힌다.
- **파산가 인수** — BP는 유저 마진이 정확히 소진되는 가격. 이 가격으로 인수하면 유저는 마진 전액 손실로 종결되고, BP와 실제 시장가의 차이(결손/잉여)는 전부 기금이 흡수한다.
- **청산 수수료 적립** — 거래 수수료는 소각이지만(ADR-025), 청산 수수료는 기금의 결손 흡수 재원이므로 적립이 목적에 맞다.
- **음수 허용 + ADL 연기** — dev 플랫폼에서 기금 고갈 시 디레버리징 대상 선정·통지까지 구현하는 것은 과함. 음수 balance는 운영자가 보는 결손 지표로 충분하다.

## Consequences

- 청산 레이턴시 = mark tick(1s) + DB 조회 — 엔진 내장 청산보다 느리지만 dev 플랫폼 수준에서 무시 가능.
- 전량 청산이므로 marginRatio가 1을 살짝 넘어도 포지션 전체가 사라진다 — Binance 사용 경험과 다른 지점.
- CO → terminal poll → NO 발행의 다단계 흐름이라 중간 크래시 시 LIQUIDATING 상태로 남을 수 있다 — 차단 규칙 덕에 안전하게 멈추며, 다음 tick의 모니터가 이어서 처리한다.
- 기금 포지션은 자동으로 닫히지 않는다 — 수동 정리 전까지 펀딩을 주고받으며 시장에 남는다 (zero-sum 유지를 위해 의도된 동작).
- 기금이 음수가 되어도 시스템은 계속 동작한다 — 손실의 사회화(ADL)가 없으므로 결손은 시스템 부채로 누적된다.
- 청산 체결도 일반 TR로 흘러 정산 상태기계([ADR-032](032-futures-settlement-state-machine.md))가 처리한다 — 청산 전용 정산 경로 없음.

## 관계
- [ADR-021](021-stop-orders-be-trigger.md): BE 트리거 + guarded claim 패턴의 원형 — 본 ADR이 청산에 동일 패턴 적용
- [ADR-025](025-trading-fees.md): 거래 수수료는 소각 — 청산 수수료는 기금 적립으로 구분
- [ADR-029](029-mark-price-internal-index.md): marginRatio 판정의 입력인 mark price 산출
- [ADR-032](032-futures-settlement-state-machine.md): LIQUIDATION_TAKEOVER 적용과 청산 수수료 차감이 실행되는 정산 상태기계
- [feedback-002](../feedback/002-order-mutations-via-matching-engine.md): 청산 주문도 엔진 경유 일반 NO로 발행하는 근거
