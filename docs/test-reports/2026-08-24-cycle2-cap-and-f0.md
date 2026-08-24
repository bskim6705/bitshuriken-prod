# 2026-08-24 — 사이클 2: 방향별 캡 + F0 그레이스풀 셧다운 (리서치→구현→적대검증)

> 사이클 1(미러 복원)에 이어. 유저 확정: 충실도 목표는 M1 착수로 상향 / 캡 방향별 수정 / 커밋.
> 산출물: ADR-072, F0 구현, M1 플랜(docs/specs/m1-settlement-split-plan.md).

## 1. 방향별 maxNotional (ADR-072)
- `assertWithinMaxNotional` 방향별 재작성: 같은 방향 포지션+미체결+신규 ≤ 캡 (반대 방향 불산입·불상쇄).
- pure spec 신설 7케이스 green. 기존 service spec 4/4 green. 라이브 반영 완료.
- 효과: MM 양측 호가가 각 사이드 캡까지 가능 — 미러 메이커의 임계 근처 간헐 거절 소멸 예상
  (다음 미러 런에서 사이드당 예산 0.25 상향 검토).

## 2. F0 그레이스풀 셧다운 (감사 A8, 전 재기동 사고 계열의 전제)
- **BE**: `applyGlobalPipeline`에 `enableShutdownHooks()` — 죽은 코드였던 onModuleDestroy 11개
  (Kafka producer/consumer disconnect·mark-price 인덱스 컨슈머 그룹 이탈 등) 전부 소생.
  양 정산 워커에 `OnApplicationShutdown` quiesce (신규 tick 차단 + 진행 중 tx 15s 대기).
- **엔진**: SIGTERM/SIGINT 핸들러 → 루프 탈출 → `publish_all_dirty`(신설, dirty lane 최종 스냅샷
  간격 무시) → producer flush → consumer close. registry 기준이라 라이브 상장 lane 포함.
- **exchange.sh**: stop 단계화 — 봇 INT(자체 정리 대기 30s) → BE TERM(셧다운 시퀀스 대기 30s) →
  엔진 TERM(스냅샷 대기 20s) → kill_all 에스컬레이션(-9)은 백스톱으로 강등.

## 3. 적대 검증 — SIGTERM 드릴 (감사 P0 게이트)
53,461 체결 트래픽 **도중** staged stop → 마커 전수 확인(be-spot/be-futures "quiesced",
match-spot/futures "stopped clean") → 봇 clear FAILED 0 (유령 0) → 재기동 → PENDING 0 드레인 →
**check-integrity: 금전 fail 0 · 패리티 fail 0** (103 warn = 미미러 무유동성). **게이트 통과.**

## 4. 다음 (사이클 3 = M1 본체)
- 신규 `apps/settle` 프로세스 (플랜 §단계). 착수 전 설계 결정 1건: futures 워커의 mark 의존
  해소 방식 ①자체 인덱스 컨슈머+경량 북 미러 ②SettlementEvent에 mark 동봉(스키마) ③mark DB
  프로젝션 — **유저 결정 대기**.
- 완료 후 게이트: kill -9 드릴 매트릭스(settle 행 포함) F1~F5 0 fail + 미러 동반 TPS 재측정
  (목표 ~300, 심볼 예산 2~3배) → 페이싱 rec150/TPS20 복원 → bench 재측정 (07-12급 회복 확인).
- 미커밋: ADR-072 구현(BE 3파일+spec), F0(BE 3파일·엔진 2파일·exchange.sh), 플랜/리포트 docs.
