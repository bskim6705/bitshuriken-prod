# 026 — 정합성 측정은 정산 드레인 후 (봇 트레이딩과 분리)

## Rule
정합성(F1~F4) 측정은 봇 트레이딩과 **분리**한다. 봇을 충분히 돌려 활동을 쌓은 뒤, **주문 흐름을 멈추고
정산이 드레인된 상태**에서 측정한다. 라이브 트레이딩과 동시에 측정하지 않는다.

## Why
주문 mutation은 매칭엔진 경유 → Kafka → 정산 워커로 **비동기 정산**된다(시스템 계약). 따라서 체결이
`Trade`로 기록된 시점과 지갑/락/`executedQty`가 반영되는 시점 사이에 짧은 창이 있다. 활발히 트레이딩하는
중에는 point-in-time 체커가 이 "기록됐지만 미정산" in-flight 상태를 잡아 F1b/F1c/F4가 **일시적 red를
깜빡인다** — 금전 사고가 아니라 정산 지연이다(주문 흐름을 멈추면 항상 0 fail로 수렴). 동시 측정은
false positive로 신호를 오염시킨다.

근거: 2026-07-12 미러 충실도 개선(taker MARKET → LIMIT IOC) 후 조밀 샘플링에서 라이브 중 F4/F1c/F1b가
깜빡였으나, 봇 정지 + 드레인 후 측정은 매번 0 monetary fail. (docs/test-reports/2026-07-12-green-baseline-strategies.md)

## How to apply
- 측정은 `./scripts/check-integrity.sh` — 봇 주문 흐름 정지(maker 락 해제) → 드레인 → F1~F4.
- 또는 봇을 멈춘 뒤 `bitshuriken-prod-bots`에서 `npm run check`.
- 라이브 중 관찰한 red는 **지속성으로만 판정**한다(수 초 뒤 재확인 시 같은 user/asset이 잔존해야 진짜 fail).
- 체커는 DB를 직접 read하는 별도 도구다 — 봇/BE 실행과 커플링하지 않는다.
