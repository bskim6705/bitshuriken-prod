# ADR-072: 선물 maxNotional 캡의 방향별 계산

## Status
Accepted (2026-08-24)

## Context
기존 `assertWithinMaxNotional`은 방향 무시 합산(|포지션| + 양측 미체결 전부 + 신규 ≤ 캡)이었다.
실거래소(Binance 레버리지 브래킷)는 방향별로 계산하므로 이 구현은 과도하게 보수적이고, 양측 호가를
상시 유지하는 마켓 메이커(미러 봇)가 자기 반대편 잔량 때문에 정상 주문을 거절당했다 — 2026-08-24
미러 복원 사이클 1에서 실측(교체 중 in-flight 이중계상과 결합해 임계 근처 간헐 거절). 유저 확정.

## Decision
노출을 신규 주문 방향별로 계산한다: **같은 방향 포지션 + 같은 방향 미체결(reduceOnly 제외) 잔량
+ 신규 ≤ maxNotional**. 반대 방향 포지션·미체결은 이 방향의 노출에 세지 않되, **상쇄해 주지도
않는다**(순잔량 네팅 없음 — 반대 방향이 먼저 체결된다는 보장이 없으므로 보수 원칙 유지).
`OpenOrderQtyRow`에 `side` 추가, 호출부(일반/스톱 접수)는 `newSide` 전달. pure spec 신설
(`futures-order-validation.spec.ts`).

## Consequences
- MM 계정이 양측 각각 캡까지 호가 가능 (방향 무시 시절의 절반 예산 강제 소멸). 미러 메이커의
  사이드당 예산(현 0.25×캡)은 다음 실측 런에서 상향 여지.
- 최악 노출(한 방향 전량 체결 시 최종 포지션)은 여전히 캡 이내 — 청산 리스크 상한 불변.
- reduceOnly 캡 면제·용량 검사(assertReduceOnlyCapacity)는 무변경.
