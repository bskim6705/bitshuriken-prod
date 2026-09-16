# ADR-077: 정산 프로세스 분리(M1)와 그레이스풀 셧다운(F0)

## Status
Accepted. 구현은 2026-08-24(F0 `85f527f`, M1 `6d7043f`·`c8565f0`)에 끝났고 당시에는 [docs/specs/m1-settlement-split-plan.md](../specs/m1-settlement-split-plan.md)와 테스트 리포트에만 기록됐다. 이 ADR은 2026-09-16에 **소급 작성**한 정본이다 — 결정·게이트·알려진 공백을 한 곳에 둔다.

## Context
- [ADR-069](069-in-memory-balance-ledger.md) S2로 Wallet 행 락 컨보이가 사라지자 병목이 **Node 이벤트루프 단일 코어**로 이동했다(관찰 #26: be-spot이 60 TPS에서 CPU ~100%, 유효 100~120 TPS, 500 오퍼 시 혼잡 붕괴). 루프를 먹는 것은 요청당 Prisma 왕복 13~15회 + 정산 컨슈머·워커·테일러·프로젝터의 JS 비용이었다.
- 2026-07-22 구조 감사([docs/specs/2026-07-22-integrity-tps-structural-audit.md](../specs/2026-07-22-integrity-tps-structural-audit.md))의 우선순위 C1 "정산·컨슈머 티어 분리"와 A8 "그레이스풀 셧다운 부재"(BE 3앱 훅 0건, `onModuleDestroy` 11개 전부 데드 코드, mark-price 컨슈머 그룹 불결 이탈).
- 2026-07-14 사고(관찰 #21/#22): `--watch` 재기동 + 리밸런스로 정산 유실·언락 유실·레인 무반응이 동시에 났다. 셧다운 시퀀스가 없으면 재기동 자체가 정합성 파손이다.
- ADR-069 §6 유저 확정 제약은 유지한다: DB append-only 저널, 저널 커밋 후 응답(RPO 0), **원장·reserve·저널 append는 API 프로세스 잔류**, 단일 인스턴스 재시작.

## Decision

### 1. F0 — 그레이스풀 셧다운 (M1의 선행 조건)
- **BE 전 앱**: `enableShutdownHooks()`(`libs/shared/src/bootstrap/apply-global-pipeline.ts`). SIGTERM/SIGINT → 신규 HTTP 거부 → Kafka 컨슈머 정지(오프셋 플러시) → 정산 워커 quiesce(`onApplicationShutdown`: 진행 중 tick 완료 대기, 유예 15s 초과 시 error 로그) → producer/consumer disconnect → exit.
- **엔진**: SIGTERM/SIGINT 핸들러로 소비 루프를 빠져나와 **최종 스냅샷 + producer flush**(`main.py`). 기본 동작(즉사)은 dirty book을 WAL replay에만 맡기던 갭이었다.
- **exchange.sh stop 단계화**: 봇 INT → BE 드레인 대기(PENDING=0 폴링) → 엔진 → 킬 에스컬레이션.
- 게이트: SIGTERM 재기동 드릴에서 check-integrity monetary fail 0 ([2026-08-24-cycle2-cap-and-f0.md](../test-reports/2026-08-24-cycle2-cap-and-f0.md)).

### 2. M1 — `apps/settle` 정산 프로세스
- **신규 Nest 앱 `apps/settle`**(HTTP는 `/health` 전용, `PORT_SETTLE`=5104). 거주 요소: `match.{spot,futures}.out` **DB 효과 컨슈머**(Trade/SettlementEvent insert, Order.status 전이, OCO 레그, dust·잔여 환불), `match.*.control` 컨슈머(런타임 상장 meta), **spot·futures 정산 워커 둘 다**, DLQ([ADR-067](067-settlement-dead-letter-queue.md)), 원장 **읽기 레플리카**(`LedgerModule.forReplica([SPOT, FUTURES])`: 부팅 리플레이 + 테일 ≤250ms), **프로젝터·드리프트 체커는 여기가 단독 구동**.
- **out 컨슈머는 이원화한다** — 통째 이설이 불가능했다. 컨슈머가 DB 정산 외에 인메모리 효과(TickerStats.applyTrade → 스탑 트리거 클록·WS 체결 팬아웃·24h 지표·가격밴드 기준, user-stream execution report)를 먹이기 때문이다. API 앱은 기존 그룹 `bitshuriken-be-{spot,futures}`로 **인메모리 효과만**(DB 무접촉), settle은 신규 그룹 **`bitshuriken-settle`**로 DB 효과. 멀티 그룹이라 오프셋이 독립이고, TR 중복 처리는 sourceKey 멱등([ADR-034](034-match-engine-state-recovery.md)/[ADR-038](038-deterministic-trade-id.md))으로 방어된다.
- **book/control/mark-price 컨슈머는 API 잔류**(인메모리 전용, GET /depth·mark가 읽음).
- **워커의 원장 동기 읽기**(futures flip/shortfall 판정 `walletBalanceOf`)는 settle의 레플리카가 답한다. 자기 append는 로컬 즉시 적용(`applyJournalRowsLocally`), API발 reserve만 ≤250ms 랙.
- **mark 의존은 이벤트 동봉으로 해소**(유저 결정): 청산·펀딩 legs가 생성 시점 mark를 들고 오므로 settle 워커에는 `MARK_READER`에 null-리더를 주입한다. 스키마 변경·마이그레이션 없음.
- **컨슈머 동시성**: `partitionsConsumedConcurrently = P_spot + P_futures`. kafkajs의 이 값은 토픽별이 아니라 전체 할당 기준이라 두 마켓 파티션 수의 합이어야 파티션당 1:1이 된다(max였을 때 절반 스로틀 → OU ack 분 단위 랙 실측).
- **exchange.sh 6지점**: PATTERNS(`dist/apps/settle/main`)·`start_component`·헬스 검증(:5104)·단일 인스턴스 가드·stop 순서(BE 앞 — PENDING 드레인 주체)·status 스탠자.
- **프로드 compose**: `be-settle` 서비스, 엔진은 settle 뒤에 기동(신규 그룹이 out을 처음부터 잡아야 첫 체결이 유실되지 않음). 이 항목은 08-24 구현에서 누락돼 있다가 2026-09-16 [ADR-076](076-product-maturity-stages-and-blast-radius.md) 작업 중 발견·추가됐다 — 없으면 체결이 지갑에 반영되지 않는다.

### 3. 게이트 결과 ([2026-08-24-cycle3-m1-settle-split.md](../test-reports/2026-08-24-cycle3-m1-settle-split.md))
- kill -9 드릴(API 앱) + staged stop(settle) → F1~F5 0 fail. settle에 대한 kill -9 드릴은 **미실시**(자인).
- 미러 동반 7심볼 p99 2.7~6.3bps @ rec150/TPS20 지속 가능. 후속 08-25 B4~B6(`90037e7`)로 settle 파이프라인 DB 왕복 축소.

## Rationale
- **이벤트루프 밖으로 DB 효과를 빼는 것**이 P4(API 수평 확장, 원장 소유권 샤딩 선행) 전에 단일 코어 천장을 올리는 유일한 수술이다([docs/specs/tps-and-failover-plan.md](../specs/tps-and-failover-plan.md) §5).
- **이원화가 이설보다 안전**: 인메모리 효과를 settle로 옮기면 WS·트리거·통계가 프로세스 경계를 넘어야 한다. 경량 그룹을 남기면 API 앱은 변경 최소, 정산만 빠진다.
- **레플리카로 동기 읽기 유지**: 워커가 API의 원장을 RPC로 묻는 대신 저널을 테일하면 API 장애가 정산을 막지 않는다. 랙 창의 오판은 F3/드리프트 체커가 게이트한다.
- **F0가 선행**: 프로세스가 하나 늘수록 재기동 지점이 늘고, 시퀀스 없는 재기동은 07-14 사고의 재현이다.

## Consequences
- BE 프로세스 **4개**(spot/futures/portal/settle). [ADR-062](062-production-deployment.md)의 "3 프로세스"는 본 ADR로 갱신(배너).
- **알려진 공백 ①** — 정산 결과 WS 이벤트(spot `outboundAccountPosition`, futures `positionUpdate`·per-fill `executionReport`)가 settle에서 **구독자 없이 소멸**한다. 플랜의 "잔고 스냅샷은 테일러 적용 시점 발화로 이동"은 미구현. FE는 REST 폴링에 의존. 해법은 `be.user-events` 브로드캐스트 토픽(tps plan §5.2 M2 ④) — ADR-076 §6-①.
- **알려진 공백 ②** — settle이 그룹 하나로 양 마켓 out을 소비하므로 futures 메시지 파싱·삽입 실패가 컨슈머 크래시 루프로 **spot 정산까지 정지**시킨다(감사 A6, ADR-076 §5의 빨간 칸). 마켓별 settle 프로세스가 ADR-076 §6-⑥.
- 레플리카 랙 창(≤250ms)의 flip/shortfall 오판에 완화 코드 없음. DLQ failCounts는 인메모리(재시작 시 리셋).
- [ADR-014](014-async-settlement-via-event-log.md)·[ADR-032](032-futures-settlement-state-machine.md)·ADR-067·ADR-069의 "워커 거주 앱" 서술은 본 ADR이 대체(각 문서 배너).
- exchange.sh는 settle 없이는 start를 완료하지 않는다(정산 없는 스택은 무효).

## 관계
- ADR-069(제약 §6, 원장 토폴로지), ADR-067(DLQ), ADR-014/032(정산 상태기계), ADR-034/038(멱등), ADR-062(배포 형상), ADR-076(제품 단계·격리 — 공백 ①②의 해소 조건)
- specs: m1-settlement-split-plan, tps-and-failover-plan §5·§6, 2026-07-22 감사 C1/A8; reports: 2026-08-24 cycle2/cycle3; 관찰 #21/#22/#26
