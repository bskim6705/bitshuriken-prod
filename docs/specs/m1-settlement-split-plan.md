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

### mark 의존 — 해소됨 (유저 결정 "이벤트 동봉" = 기존 구조로 이미 충족)
실사 결과 워커의 mark 사용은 ① `leg.mark` — 청산/펀딩 legs가 **생성 시점에 mark를 이미 동봉**
(생성자인 futures 앱이 mark 보유) ② WS 스냅샷 보강용 `tryGetMark`(nullable, settle엔 구독자
없음) 뿐. 컨슈머 경로는 mark 무사용. 따라서 스키마 변경·마이그레이션 불요 — settle의 워커에는
`MARK_READER` 토큰으로 null-리더를 주입하고(futures 앱은 MarkPriceService 바인딩), 정산 수학은
legs 동봉 mark로 종전과 동일하게 결정적. 의존성 눈사태는 발생하지 않는다.

## 리스크 (적대 검증 표적)
정산 레플리카 랙 창의 flip/shortfall 오판 / A13 테일러 gap-grace(500ms 영구 스킵) × 프로세스 간
저널 트래픽 증가 / A6 컨슈머 poison 크래시루프가 정산 티어 전체 정지로 승격 / 이원 그룹의 TR 중복
처리(멱등 sourceKey로 방어되는지) / 24h 리하이드레이트·부트 리플레이 시간.
