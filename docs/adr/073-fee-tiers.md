# 073. 수수료 티어 (수동 지정, 리베이트 없음)

## Status
Accepted (2026-08-25)

## Context
유저당 플랫 maker/taker 10bps(admin이 bps를 직접 수정)는 이 거래소의 목적(스캘핑·HFT·아비트라지 전략 테스트)을 구조적으로 막는다 — 실측: 테이커 왕복 20bps에 스캘핑 6종 전패(lessons L1), 김프 삼각 arb 무발화(L6, 재설계 조건이 "메이커화 or 수수료 티어"). 실거래소의 HFT/MM/arb는 볼륨 티어 위에서 성립한다.

## Decision
- **수동 티어 지정**: `User.feeTier Int @default(0)`. admin이 `PATCH /admin/users/:id/fee-tier`로 지정. 볼륨 자동 산정(30d 롤업)은 하지 않는다.
- **티어 테이블은 코드 상수** (feedback-020): `libs/shared/src/constants/fee-tiers.ts`, spot/futures 별도 컬럼. T0 = 10/10(스팟·선물 동일) — **종전 기본 동작 불변**. 상위 티어로 갈수록 하강, **maker 하한 0bps — 리베이트(음수 수수료) 없음**.
- 정산·주문 락 산정·커미션 조회는 전부 `UserService.feeRatesOf(userId, market)` 단일 촉점에서 tier→테이블 해석. 60s TTL 캐시는 tier를 캐싱.
- 기존 `User.feeMakerBps/feeTakerBps`와 `PATCH /admin/users/:id/fee`는 **deprecated — 표시 전용**(정산이 읽지 않음). 컬럼·엔드포인트는 보존.
- 서브계정은 생성 시 마스터의 feeTier를 상속(기존 bps 복사와 동일한 규칙).

## Rationale
- 티어 자동 산정은 30d 볼륨 롤업 인프라가 필요하고, 테스트 통제(전략 A는 T0, 전략 B는 T4 비교) 목적에는 수동 지정이 오히려 낫다. 유저 확정: "수동 티어 지정".
- 리베이트 배제는 정산 경로(수수료 합산 불변식·정합성 검사)가 음수 fee 지급을 다루는 확장을 피한다. 필요해지면 별도 ADR. 유저 확정: "허용 안 함, 하한 0".
- T0 불변으로 기존 봇·기준선(bench·정합성)에 영향 0 — 티어는 지정한 계정에만 발효.

## Consequences
- 전략/봇 테스트가 실거래소형 수수료 구간에서 가능해짐 (arb 발화 조건 확보).
- 티어 값 변경은 코드 수정+재배포 (정책 상수 규칙과 일관).
- 마이그레이션 1회 필요 (`feeTier` 컬럼). spot/futures/portal 프로세스 간 티어 반영은 캐시 TTL ≤60s 지연 — 종전 bps 변경과 동일한 시맨틱.
