# M1 정산 프로세스 분리 — 구현 플랜 (사이클 2 리서치 산출물)

> 2026-08-24. 목표: BE 유효 TPS 100~120 → ~300 (미러 심볼 예산 2~3배). 근거 문서: 07-22 감사 C1/A8,
> tps-and-failover-plan §5/§6, ADR-069 §6 유저 확정, S2 캠페인 미결 #1. 코드 배선 실사 결과 포함.

## 확정 제약 (유저 기결정, ADR-069 §6)
DB append-only 저널(Kafka 아님) · 저널 커밋 후 응답(RPO 0 — **원장·reserve·저널 append는 API 잔류**)
· PG 동기 커밋 · 단일 인스턴스 재시작(leader election 없음) · 프로젝션 랙 ≤1s/5s 경보.

## 실사에서 나온 설계 수정 (문서에 없던 결합점)
1. **out 컨슈머는 이원화한다** (통째 이설 불가). 컨슈머가 DB 정산 외에 인메모리 효과를 먹임:
   TickerStats.applyTrade(→ 스탑 트리거 클록·WS 체결 팬아웃·24h 지표·가격밴드 기준), user-stream
   execution report. → **API에 경량 그룹**(`bitshuriken-be-{app}` 유지: 인메모리 효과만, DB 무접촉),
   **정산 프로세스에 신규 그룹**(`bitshuriken-settle`: Trade/SettlementEvent/Order.status INSERT/UPDATE
   + OCO 레그 + 정산 워커). Kafka 멀티 그룹이라 서로 독립 오프셋.
2. **book/control/mark-price 컨슈머는 API 잔류** (인메모리 전용, 저비용 — GET /depth·mark가 읽음).
3. **futures 워커의 원장 동기 읽기** (`walletBalanceOf` — flip/shortfall 판정): 정산 프로세스가
   자기 JournalTailer+LedgerService **읽기 레플리카**를 굴린다 (자기 append는 로컬 즉시 적용 —
   기존 applyJournalRowsLocally 재사용; API발 reserve는 ≤250ms 랙). 랙 창의 오판은 F3/드리프트
   체커가 게이트 — **적대 검증 필수 항목**.
4. 프로젝터·드리프트체커·순자산 크론(H5)·DLQ는 정산 프로세스로. API 테일러는 잔류(문서 모순은
   이렇게 해소 — 감사 C1의 "테일러 이설"은 정산측 레플리카 신설로 읽는다).
5. user-stream 공백: 정산 워커가 내던 잔고 스냅샷/리포트 이벤트는 분리 후 API에서 안 나감 →
   1단계는 경량 컨슈머의 OU 기반 execution report로 대체하고, 잔고 스냅샷은 테일러 적용 시점
   발화로 이동 (동일 인메모리 EventEmitter).

## 단계
### F0 (선행, 감사 우선순위 #2 — A8)
- BE 3앱: `enableShutdownHooks()` + SIGTERM/SIGINT 시퀀스 — 신규 HTTP 거부 → 컨슈머 stop(오프셋
  플러시) → 워커 quiesce(진행 중 tx 완료 대기) → producer/consumer disconnect → exit.
  (현 상태 실측: 훅 0건, onModuleDestroy 11개 전부 데드 코드, mark-price 컨슈머 그룹 불결 이탈.)
- 엔진: SIGTERM 핸들러 → 최종 스냅샷 + producer flush.
- exchange.sh stop 단계화: 봇 INT → BE 드레인 대기(PENDING=0 폴링) → 엔진 → 킬 에스컬레이션.
- **게이트**: SIGTERM 재기동 드릴 → check-integrity monetary fail 0.
### M1 본체
- 신규 nest 프로젝트 `apps/settle` (createApplicationContext + 최소 헬스 HTTP :5104):
  신규 그룹 out 컨슈머(DB 효과) + 양 정산 워커 + DLQ + 프로젝터 + 드리프트체커 + 순자산 크론 +
  원장 읽기 레플리카. 기존 앱에서 해당 모듈 제거/역할 분기 (포털 원장 모듈의 역할별 배선 선례).
- API 경량 컨슈머: TR→tickerStats.applyTrade, OU→user-stream report (DB 무접촉).
- exchange.sh 6지점: PATTERNS(argv `dist/apps/settle/main`)·start_component·헬스 검증(:5104)·
  단일 인스턴스 가드·stop 순서(BE 앞, 엔진 뒤 아님 — PENDING 드레인 주체)·status 스탠자.
- **게이트**: kill -9 드릴(정산 프로세스 행 포함) F1~F5 0 fail + 미러 동반 TPS 재측정.

### M1 본체의 의존성 눈사태 (실사 추가 발견 — 설계 필요)
`FuturesSettlementWorker`가 `MarkPriceService`를 주입받고(shortfall/ADL 판정), MarkPrice는
`OrderBookCacheService`를 읽는다(computeMarks) — 워커를 옮기면 인덱스 컨슈머+북 컨슈머까지
따라온다. 선택지: ① settle 프로세스에 자체 인덱스 컨슈머+경량 북 미러(그룹 분리, 저비용이면 수용)
② 워커의 mark 의존을 "정산 시점 mark 스냅샷"으로 좁혀 futures 앱이 SettlementEvent에 mark를
동봉(스키마 추가 — ADR-067 교훈: 신규 컬럼은 pre-migration unsafe, 신규 테이블/컬럼 마이그레이션
동반) ③ mark를 저널/DB 프로젝션으로. 이 결정이 M1 본체 착수 전 첫 설계 항목.

## 리스크 (적대 검증 표적)
정산 레플리카 랙 창의 flip/shortfall 오판 / A13 테일러 gap-grace(500ms 영구 스킵) × 프로세스 간
저널 트래픽 증가 / A6 컨슈머 poison 크래시루프가 정산 티어 전체 정지로 승격 / 이원 그룹의 TR 중복
처리(멱등 sourceKey로 방어되는지) / 24h 리하이드레이트·부트 리플레이 시간.
