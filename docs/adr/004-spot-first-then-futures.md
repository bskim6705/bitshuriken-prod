# ADR-004: Spot 먼저 end-to-end, futures는 그 다음

## Status
Accepted

## Context
매칭엔진과 백엔드 연동, spot/futures 분리 시점에 대한 작업 순서를 정해야 한다.

## Decision
Spot을 먼저 end-to-end로 완성한 후에 futures를 추가한다. 분리 추상화는 미리 만들지 않는다.

작업 순서:
1. **Match engine (Python)** — spot orderbook + 가격-시간 우선순위 매칭 + 체결 결과를 Kafka로 publish
2. **BE consumer** — 매칭 결과 수신 → Order status 업데이트, Trade 생성, Wallet 잔고 변경 (트랜잭션)
3. **e2e 테스트** — 두 유저 매칭 시나리오로 wallet/order 검증
4. **Futures 추가** — margin/position 로직만 새로 붙이고, 매칭엔진 코어는 재사용

## Rationale
- 현재 BE의 order flow가 반쪽이다 (PENDING 저장 + Kafka emit까지만, 결과 처리 없음). 매칭엔진 없이 BE를 더 확장해도 검증이 불가능.
- 방금 정의한 Kafka 메시지 contract(`match.new-order`, `match.cancel-order`)가 실제로 동작하는지 확인이 필요.
- Spot이 한 번 동작하고 난 후에 futures를 붙이면, 진짜 공통점/차이점이 드러나서 추상화가 자연스럽게 결정된다.
- 미리 분리하면 추측 기반 추상화(premature abstraction)가 된다.
- ADR-002의 "단일 매칭엔진 + 전후 처리 분기" 전략과 일치.

## Consequences
- Futures 관련 코드는 spot end-to-end 검증이 끝날 때까지 작성하지 않는다.
- 매칭엔진 코드 구조는 처음부터 MarketType을 인식하되, futures 전용 분기는 비워둔다.
- Spot이 동작한 시점에 futures 작업 범위(증거금, 포지션, 청산, 펀딩비)를 다시 ADR로 정리한다.
