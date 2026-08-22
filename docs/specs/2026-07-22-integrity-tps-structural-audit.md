# 정합성·TPS 구조 감사 — 2026-07-22

> **Status: 리스트업 전용 — 구현 없음 (유저 지시).**
> 방법: 병렬 포드 7기 (BE 핫패스 / 정산·원장 / 매칭엔진 / Kafka·인프라·운영도구 / 선물 도메인 / 포털 비거래 잔고 / 문서 대장) + 완전성 비평 포드 1기(신규 6건, §H) + 반박 검증 포드 1기(고심각 5주장 전부 CONFIRMED, §G′) + 오퍼레이터 스팟체크 3건. 전부 2026-07-22 현재 코드 기준 (07-15 플랜 문서의 라인 번호는 다수 stale — 본 문서가 최신).
> 경로 축약: BE=bitshuriken-prod-be, MATCH=bitshuriken-prod-match, INFRA=bitshuriken-prod-infra.

## 0. 요약

**현재 그림**: 잔고 경로(ADR-069 S2)는 견고해졌으나 그 전환이 **새 구조 구멍 2개**를 만들었다 — ① 포털 콜드플로(S2b 미완)가 여전히 Wallet 행을 진실로 취급, ② 선물 정산의 잔고 판단이 S0의 FOR UPDATE 직렬화를 잃음. 엔진 쪽엔 **체결이 유실/이중화될 수 있는 원자성·펜싱 갭 4개**가 코드로 확정됐다. TPS는 관찰 #26 그대로 이벤트루프 단일코어가 천장이며, 사다리는 F0→M1→CPU 다이어트→선물 keyed-lane→P4로 확정적.

**최상위 정정 2건**: (1) 관찰 #27(exchange.sh 재빌드 미배포)은 **현재 스크립트에서 수정 완료** — `scripts/exchange.sh:99-113` 상대경로 argv 패턴 + `free_be_ports` + `assert_be_listener`. 문서만 stale. (2) "정합성 클린"은 kill -9 원장 드릴 범위에 한정 — #24 straddle·F4 컴포넌트 매트릭스·F0 부재는 미검증 영역.

**즉효 콤보 (합계 반나절 미만, 정합성 리턴 최대)**: 엔진 producer idempotence + emit 전달실패 콜백 + 스냅샷 전 flush() + flock 펜싱, BE producer idempotent:true, fromBeginning:true, 청산 집행기 원장 읽기 1줄, 프로젝터 실패 시 재-dirty, 레버리지 변경 열린주문 가드.

---

## A. 정합성 — 돈이 새거나 증발할 수 있는 구조 구멍 (심각도순)

| # | 문제 | 기전·근거 | 해법 | 규모 |
|---|---|---|---|---|
| A1 | **S2b 미완 — 포털 4경로(이체·입출금·서브계정·어드민)가 S0 이중쓰기 잔존** | 충분성 검사가 ≤500ms stale한 Wallet 프로젝션 대상 + `applyJournal`은 무조건 적용(BE libs/core-domain/src/ledger/ledger.service.ts:184-193, 스팟체크 확증) → 주문 reserve로 소진된 잔고를 이체/출금으로 재지출 가능(원장 음수는 로그만). 프로젝터 절대값 upsert가 포털 debit을 일시 부활시켜 2차 지출 창 추가(ledger-projector.ts:39-67). futures 이체 게이트의 행 락은 S2에선 아무것도 직렬화 안 함(transfers.service.ts:67-69 주석의 전제 소멸) | ADR-069 §6 원안 구현: 포털=저널 append만, 충분성 검사는 소유 앱 테일러의 적용 시점 + bounded 대기. 중간 완화: TRANSFER/WITHDRAWAL kind는 음수 유발 시 거부/파킹 | M-L |
| A2 | **선물 정산 잔고 판단의 직렬화 소멸 (S2 회귀)** | flip IM·펀딩 워터폴·shortfall 판단이 무락 원장 스냅샷 읽기 → 여러 await → 커밋 후 원장 반영(futures-settlement.worker.ts:180-186, 812-818). 동시 reserve/debit/테일러와 인터리브 시 stale 판단 → 침묵 음수. 동일유저 자전 체결은 maker 델타를 taker 판단이 못 봄 | `ledger.judgeAndApply`(읽기→판단→반영 사이 await 0, reserve 패턴) 또는 (user,asset) 인프로세스 뮤텍스. **A2가 C4(keyed lanes)의 전제** | S-M |
| A3 | **엔진 out↔스냅샷 원자성 갭 — 체결 유실 가능** | out(TR/OU)과 state 스냅샷이 같은 async 큐, flush 없이 발행(snapshot_store.py:139-153 스팟체크 확증). 스냅샷(offset X)만 전달되고 X 이하 TR 미전달 상태에서 크래시 → 리플레이는 X+1부터 → **그 체결은 영원히 재발행 안 됨**. 덤: `dirty=False`를 produce 시점에 세팅해 크기초과 스냅샷도 성공으로 오인 | 스냅샷 발행 직전 `producer.flush()` 1줄 + dirty=False를 delivery 콜백으로 이동. 정석은 트랜잭셔널 프로듀서(A5와 겸용) | XS |
| A4 | **#24 straddle 잔존 + 양쪽 프로듀서 비멱등** | terminated FIFO(50k)가 스냅샷 미포함(MATCH schemas/snapshot.py:21-35) → 재기동 걸친 중복 NO는 여전히 팬텀 체결. 중복 NO의 원천 = BE kafkajs 기본 프로듀서(비멱등, kafka.service.ts:17), 엔진도 동일(producer.py:6-8, 재시도 시 TR/OU 역전도 가능) | ① BE `idempotent:true` ② 엔진 `enable.idempotence=true` ③ terminated FIFO를 스냅샷에 포함(최신 N개면 충분) | XS+S |
| A5 | **엔진 스플릿브레인 무펜싱** | manual assign이라 그룹 조정 자체가 없음 — 두 엔진 동시 기동 시 각자 매칭·각자 TR 발행(다른 maker-taker 쌍 = 다른 sourceKey → BE가 둘 다 정산). 고아 프로세스 이중 기동은 실사고 이력 클래스(CLAUDE.md 함정 ③) | 즉효: 부트 시 per-market flock, 실패 시 기동 거부. 정석: transactional.id 펜싱(A3 겸용) | XS / M |
| A6 | **컨슈머 티어 poison·unknown = 파티션 정지 or 침묵 소각** | BE: Nest handleEvent에 try/catch 없음 → parse 실패 1건이 그룹 전체 크래시 루프(K3). unknown ticker/order면 TR을 **버리고 offset 커밋**(match-event-orchestrator.ts:40-43 — 금전 메시지 침묵 소각, 상장 이중 config 함정의 재현 경로). 엔진도 인바운드 파싱 uncaught → 크래시 루프, 리플레이가 같은 메시지 재적중(MATCH main.py:150-166) | 컨슈머 단 파킹 테이블(ADR-067 미러) + 분류-격리-경보; 엔진은 per-message try/except + 스킵 카운터 | S-M |
| A7 | **place 커밋↔NO 발행 크래시 창 — NEW+locked 영구 고아** | 일반 주문엔 redispatch 스윕 없음(스톱/OCO만 redrive 존재). 엔진 다운 중 NO는 OFFSET_END 스킵으로도 동일 병리. #22류 레인 웨지도 같은 결과 | 부트+주기 스윕: NEW·T분 초과·무에코 → NO 재발행(#24 수정으로 재발행 멱등 안전) 또는 취소+언락. **F4 병리의 제네릭 해답** | S |
| A8 | **F0 그레이스풀 셧다운 전무 + stop이 무순서 킬** | 3앱 셧다운 훅 0건(3개 포드 교차 확인), 엔진 SIGTERM 핸들러 없음 → finally flush 미실행. exchange.sh stop은 봇·BE·엔진 무순서 pkill(exchange.sh:119-135) — **모든 정지가 unclean stop** = #21/#22 재현 조건 상시화 | BE `enableShutdownHooks`+시퀀스(HTTP off→consumer stop→worker quiesce→flush), 엔진 SIGTERM→최종 스냅샷→flush. stop을 단계화(봇 INT→BE 드레인 대기→엔진→킬 에스컬레이션) | S-M |
| A9 | **청산 3중 취약: 기아·bad-debt 미흡수·마크 staleness 무가드** | ① 심볼당 1포지션/틱 + 글로벌 드레인 배리어 10s 타임아웃 → 폭락 캐스케이드에서 청산 처리량 0 수렴(92s 드레인 실측과 결합) ② 파산 초과손실을 보험기금이 안 메움 — 음수 잔고 영구 방치, 기금 지급능력 무감시 ③ spot 흐름 정지 시 인덱스 영구 동결인데 청산·펀딩·트리거가 계속 소비 | ① 틱당 전체 클레임+병렬 집행, 글로벌→per-key 워터마크 ② INSURANCE_BADDEBT 이벤트+『flat이면 잔고≥0』invariant (정책 확정 필요) ③ 인덱스 age TTL → MARK_STALE 강등 | M |
| A10 | **레버리지 변경 익스플로잇 (유저 도달 가능)** | 가드가 `qty=0 ∧ NORMAL`만 검사(futures-trading.service.ts:538-548, 스팟체크 확증) — lev50으로 LIMIT 걸고 lev1로 변경 → 체결 시 marginAdd=전체 명목가치, lockedRelease=1/50 → 의도적 음수 잔고 | 심볼에 비종결 주문 있으면 레버리지/마진모드 변경 거부(Binance 시맨틱) | XS |
| A11 | **펀딩 라운드 침묵 스킵 + 스냅샷 qty 배분 오차** | 트리거가 cron 단독(0,8,16시) — 경계에 앱 다운이면 라운드 통째 증발, 흔적 0(부트 캐치업 부재). 적용도 스냅샷 qty 기준이라 백로그 시 유저별 배분 부정확(제로섬은 유지) | 부트/시간별 스윕: 최근 경계에 FundingRate 행 없으면 settleSymbol 실행. 배분은 적용 시점 락 행 qty로 재계산 | XS-S |
| A12 | **원장 부트스트랩 2함정 (S0 안전장치가 S2에서 위험으로 반전)** | ① baseline 스킵(저널 비었는데 BASELINE 없음)이 로그만 남기고 진행 → 프로젝터가 과소 원장값으로 Wallet 행 덮어씀 = 능동적 파괴(ledger-baseliner.ts:62-73) ② availability probe가 프로세스별 1회 latch — 포털만 degrade면 **저널 없는 Wallet 쓰기**(유일한 무저널 변이 경로) | LEDGER_TRUTH에선 둘 다 fatal(기동 거부)로 반전 | XS |
| A13 | **테일러 gap-grace 500ms — 포털 저널 영구 스킵 가능** | autoincrement 갭을 2틱(500ms) 후 영구 스킵하는데, 포털 이체 tx는 PENDING 백로그 O(n) 스캔을 품고 있어 커밋이 정확히 과부하 때 500ms를 초과 → 크로스앱 엔트리 유실(재기동 replayAll 때만 자가치유) | 스킵 seq를 N분간 재탐침 + PENDING 스캔을 debit tx 밖으로 | S |
| A14 | **중복 NO REJECTED가 산 주문 클로버 + cancel-reject 부재** [검증 CONFIRMED — 주장보다 심각] | 엔진이 RESTING 주문의 중복 NO에도 REJECTED OU를 원래 id로 발행(matcher.py:40-43 `contains or was_terminated`) → BE 가드는 `wasTerminal`뿐이라 OPEN/**PARTIAL** 주문에 status=REJECTED + eq=0 기준 **전체 lockedCost 환불**(match-event-orchestrator.ts:112-131,195-219). 엔진 북엔 원본 잔존 → 이후 실체결이 REJECTED 행에 정산(#25 후보 기전). 없는 id CO는 침묵 no-op | REJECTED는 NEW/PENDING일 때만 적용; 엔진에 dup 마커·CR(cancel-reject) op 추가 | S |
| A15 | **DLQ 3결함** | ① 과부하 오탐 격리: pool timeout도 poison과 동일 카운트 — 500ms 정체로 정상 금전 이동이 격리 ② replay/requeue 도구 0 (격리 = raw SQL 외 복구 불능) ③ failCounts 인메모리 → 재기동마다 스톨 재발 | 오류 분류(transient는 backoff, deterministic만 카운트) + 어드민 requeue/discard + attempts 영속화 | S |

## B. 정합성 — 감지·운영 부재 (사고를 침묵시키는 구조)

| # | 문제 | 해법 |
|---|---|---|
| B1 | 레인 워치독 부재 — #22 클래스(소비하되 미처리)는 지금도 인간 감지(25분 실측) | 엔진 per-lane 헬스 하트비트(offset·seq·counts 무조건 발행) + Δoffset>0 ∧ Δseq=0 알람 + stuck NEW>500 알람 |
| B2 | 음수·드리프트 관찰만 — 동결·격리 없음. 백로그 중엔 음수 경보가 debug로 강등(정확히 사고 나는 순간에 침묵) | 지속 드리프트/steady 음수 → 해당 키 콜드플로 동결 + 경보. 크기 임계 초과 음수는 백로그 중에도 error |
| B3 | 엔진 침묵 실패 4종: out 전달실패 무콜백(TR 소실 무로그) · 리플레이 창 초과 시 low로 침묵 클램프 · 신규 레인 첫 스냅샷(≤30s) 전 크래시 = 전량 유실 · 스냅샷 크기초과 영구 나선 | emit 콜백 + WAL 갭은 기동 거부(feedback-014) + 첫 dirty 시 즉시 스냅샷 + message.max.bytes 명시 |
| B4 | **pg 백업 자동화 전무** — 단일 pgdata 볼륨 = 전체 금전 진실(저널 포함), 재해 RPO=∞ | 야간 pg_dump -Fc + 오프호스트 1시간 작업. 이후 WAL 아카이빙 |
| B5 | 앱 티어 헬스체크 0 (compose는 pg·kafka만) — hung-but-alive 자동복구 없음. dev kafka 볼륨 없음(`down` 한 번에 WAL·오프셋 증발, DB만 생존 = 반쪽 뇌) | BE 기능 엔드포인트 healthcheck + 엔진 하트비트 파일; dev compose에 kafkadata 볼륨 + auto-create OFF. 단 **A8 이후에** (unclean 재기동 증폭 방지) |
| B6 | 저널 기반 lock reconciler 미구축 — 주문별 lock+trade+refund 합산=0 검증이 가능해졌는데(#25가 요구한 관측수단) 안 만듦 | 드레인 후 per-order 합산 스윕 → 누수 orderId·금액 특정 |
| B7 | **전 작업 미커밋** — BE 51파일 + MATCH 7파일(원장 전체 포함)이 VCS 기준선 없음. 리뷰·바이섹트·롤백 불능, 사고 시 코드 상태 재현 불가 | 유저 결정: 커밋 단위 정리 (본 감사는 커밋하지 않음) |
| B8 | 보험기금 무계기 — 마진 없는 방향성 포지션 + 음수 허용인데 status/check-integrity에 지표 0 | 기금 자본(잔고+UPNL) 지표 + 임계 경보 |
| B9 | check-integrity 드레인이 맹목 sleep 20s (실측 드레인 60-92s → 필요할 때 오탐) | PENDING=0 폴링으로 교체 |

## C. TPS — 구조 (천장을 옮기는 것, 사다리 순서)

| # | 레버 | 내용 | 기대 |
|---|---|---|---|
| C1 | **M1 정산·컨슈머 프로세스 분리** (전제 A8=F0) | out 컨슈머+양 워커+DLQ+테일러/프로젝터를 별도 프로세스로. 동반: 이벤트루프 호그 퇴거 — DriftChecker 30s Wallet 풀스캔, TickerStats 24h 윈도 O(n) shift/재스캔(FIX-1이 5m만 고침), 프로젝터/테일러 틱 | place가 정산 버스트와 코어 경쟁 중단; 기아 임계 자체 제거. **A2 해법의 자연 거주지** |
| C2 | **CPU 다이어트 (DIAG-2 잔여 top)** | ① Prisma 직렬화 ~29%: 핫 create의 narrow select(저널 반환 미사용), 2-INSERT를 CTE 단문 raw SQL로 ② Decimal.js ~16%: DTO→scaled bigint 1회 파싱, 검증·락 계산 bigint화(scaled.ts 프리미티브 기존재) ③ futures place interactive tx→batch(스팟 패턴 이식) | 단일코어 원시 300-350/s 전망(DIAG-2) |
| C3 | **정산 배치화** | 스팟 워커 tx: 순차 await ~2,000왕복/500이벤트 → createManyAndReturn+VALUES 조인 UPDATE로 ~5왕복. 컨슈머 Q5/Q6/Q7(전부 미해결): metaOf 사용·비-OCO 스킵·fill 디테일 TR→OU 탑재(엔진 계약). futures OU의 무조건 lastFillDetail 2쿼리는 executedQty>0 게이트 1줄. futures 워커 15-20 stmt→6-8(주문 필드를 이벤트 legs에 탑재, lockPosition 단문화, income createMany) | 드레인 천장 ~10×, 컨슈머 메시지당 4→1-2쿼리 |
| C4 | **선물 keyed lanes + 포지션 원장** (전제 A2) | 의존키 = {makerUser:sym, takerUser:sym, fund:sym} 집합 — 교집합 없는 그룹 병렬, 키 내 seq 직렬(엔진 Lane 패턴 이식). 그 다음 PositionState 인메모리 + 저널 + 행=프로젝션(ADR-069 플레이북 재사용, S0 섀도→kill-9→스위치) | 선물 체결 ~50-150 fills/s 천장 해체; 청산 per-key 워터마크가 공짜로 파생(A9①) |
| C5 | **응답 시맨틱 (유저 결정 §6-4/§8)** | produce를 응답 경로에서 제거(아웃박스/비동기 dispatch — NEW 행은 이미 내구) → reserve-then-respond(P3: 접수 1k+, 무경합 p50<20ms) | 자릿수 단위 접수 처리량 |
| C6 | **백프레셔** — 500 오퍼→81 붕괴는 무가드 혼잡붕괴. per-user 인플라이트 세마포어+429, 이벤트루프 lag 셰딩(perf_hooks) | 붕괴→평탄 포화로 전환 |
| C7 | **P4 전제 정리** | 컨슈머 2계급 분리(파생=인스턴스별 그룹 브로드캐스트/효과=단일 소유 — mark-price 서비스도 동일 결함), 원장 소유권 토폴로지(§6-6), M2 블로커 5종 | API ×N 가능 조건 |

## D. TPS·안정성 — 전술 (독립 실행 가능 왕복/부하 컷)

- **인덱스 3종** (유저 마이그레이션): SettlementEvent `[status,kind,seq]`(=Q9, 백로그 정렬), Position `[tickerSymbol,status,marginMode]`(청산 모니터가 심볼×1/s 무인덱스 스캔), `PENDING` partial index(드레인 쿼리를 히스토리 크기가 아닌 백로그 크기로)
- **autovacuum 튜닝**: SettlementEvent/Order/Wallet에 scale_factor 0.01 등 — **500k행 정산 임계 하락(07-14 실측)의 기전 직격**. shared_buffers 128MB 기본값 탈출, prod DATABASE_URL에 connection_limit 명시(현재 무제한 → cpu×2+1 ×3앱이 max_connections 100 초과 가능)
- Q4: 티커 status를 meta 맵 캐시 + control 토픽 무효화(컨슈머 이미 인프로세스 — TTL보다 halt 반영 빠름)
- 오픈오더 count 인메모리 카운터(캡이 원래 soft), futures place 5 read→2(count+findMany 병합, LIQUIDATING 인메모리 플래그)
- nginx upstream keepalive(현재 요청마다 새 TCP — Connection 헤더 맵이 close 유발), 앱별 `stop_grace_period`
- **핫심볼 파티션 재배치는 데이터 변경만으로 가능**: BTC+WLD가 p0, ETH+DOGE가 p2에 동거(FNV%6 실계산) — `Ticker.partition` 컬럼이 이미 진실이므로 드레인 후 재배치+config 재생성. M1 이후 유효 병렬도 ~2-3→6. P 증설 런북은 사전 작성 필요(라이브 불가)
- ledger applied Set 무한 성장(1M+ 문자열, forgetApplied 호출 0) + 전체 저널 부트 리플레이 → 워터마크 프루닝 + 저널 스냅샷(§6-3 후속). 이체 클라이언트 멱등키(재시도=이중 이체)
- 엔진 위생: GC를 유휴 전용→60s 폴백 추가, publish_due 레인 선형스캔→next-due, fromBeginning:true(BE 첫 부트 유실 창), 컨트롤 부트 언더리드 ERROR화, 미할당 파티션 라이브 상장 시 re-assign
- ENV 표기 3종 통일(MATCH_PARTITIONS vs MATCH_{SPOT,FUTURES}_PARTITIONS — dev/prod/BE 불일치 = 레인 매핑 파괴 클래스), 토픽 init 스크립트 2벌 단일화, state 토픽 segment.ms(컴팩션이 실제론 안 돎 → 부트 리플레이 무한 성장), start에 migrate status 게이트
- STP(자전거래 방지) 부재 — maker.user==taker.user 정상 체결 중(봇=유저 환경에서 비가설적). EXPIRE_TAKER 5줄, 단 정책 확정 필요

## E. 우선순위 통합 Top 10 (정합성 우선, 노력 대비)

1. **즉효 콤보** (§0, 반나절): A3 flush + A4 idempotence×2 + A5 flock + A10 레버리지 가드 + H1 선물 트리거 redrive 이식 + 청산 원장읽기 1줄 + 프로젝터 재-dirty + A12 fatal화
2. **A8 (F0+stop 단계화)** — 모든 재기동 사고 클래스의 전제; 이후에만 B5 헬스체크 안전
3. **A1+A2 (S2b + judgeAndApply)** — S2가 남긴 구조 구멍 2개; M1과 자연 결합
4. **A6+A7 (컨슈머 파킹 테이블 + NEW 스윕)** — 침묵 소각·영구 고아의 제네릭 봉합
5. **B4 pg_dump** (1시간) + B1 워치독
6. **C3 배치화+D 인덱스/vacuum** — M1 전에 가능한 최대 정산 리프트
7. **C1 M1 분리**
8. **C2 CPU 다이어트** (→300-350/s)
9. **A9 청산 3종 + A15 DLQ 도구** (정책 결정 동반)
10. **C4→C5→C7** (ADR·유저 결정 게이트)

## F. 유저 결정 필요 (feedback-016)

① STP 모드(EXPIRE_TAKER 권고) ② bad-debt/보험기금 정책(자동 스윕 여부) ③ 백프레셔/rate-limit enforcement ④ 응답 시맨틱(아웃박스·reserve-then-respond) ⑤ mark staleness TTL 값 ⑥ 레버리지 변경 규칙(열린주문 거부 = Binance 동일) ⑦ 미커밋 51+7파일 커밋 단위 ⑧ 기존 §8 잔여(RF=1, 목표 수치, P4 토폴로지)

## H. 완전성 비평 라운드 — 신규 발견 6건 (1차 포드 7기가 놓친 것)

| # | 문제 | 기전·근거 | 해법 | 규모 |
|---|---|---|---|---|
| H1 | **선물 트리거 dead-path — spot #3 수정 미이식 (armed + 증거금 잠금 고착)** | arm(claim+증거금 잠금) 커밋 후 NO 전송 실패 시 재발화가 'lost'로 침묵 리턴(futures-trigger.service.ts:83-88,140-153; margin.service.ts:292-309) → 재기동 부트 복구까지 고착. 폭락장(stop 몰리는 순간=실패 확률 최대)에 유저 stop 미발행. A7 스윕은 이 케이스 안 덮음 | spot `redriveArmedNo`(trigger.service.ts:115-129, 07-11 검증) 그대로 이식 | XS |
| H2 | **kline 파이프라인 — 캔들 저장 0, 매초/매요청 O(윈도 전체 체결) 재집계 + array_agg 메모리 폭탄** | `(array_agg(price ORDER BY seq))[1]`이 버킷 전 체결가를 실체화(kline.service.ts:80-96); WS 구독자당 매 1s getKlines 재실행(market.gateway.ts:75-80,256-286); REST kline_1M×limit1000 = 심볼 전 역사 월 단위 집계. **인증만 있으면 유저 도달 가능한 DB DoS**, 정산과 같은 pg 공유 | 단기: window function 교체 + interval×limit 캡 + WS 현재버킷 증분. 정석: 1m 캔들 테이블 증분 upsert, 상위는 1m 파생 | S/M |
| H3 | **WS backpressure 전무 + depth가 DPD 메시지당 무스로틀 풀스냅샷** | `bufferedAmount` 검사 0건 — 느리지만 pong하는 클라이언트의 송신버퍼가 프로세스 메모리로 무한 성장. depth는 Kafka DPD당 50레벨 format+발행(market.gateway.ts:106-124) — 이벤트율=주문율이라 100+TPS 심볼 구독자 1명이 place와 같은 이벤트루프 소모 | bufferedAmount 임계 drop/종료(실거래소 시맨틱) + depth를 dirty-set 1s tick으로 | S |
| H4 | **상장 3중 진실(DB/control 토픽/tickers.json) 무대사 + 디리스팅 플로 부재** | 엔진 unknown lane NO는 침묵 drop(main.py:138-146); ControlOp는 ADD뿐; dev Kafka 무볼륨이라 런타임 상장 기록 증발 시 DB=TRADING·엔진=lane 없음 → NEW+locked 고아(A7과 다른 뿌리). setTickerStatus는 status 플립만 — CO 스윕·stop 취소·포지션 정리 없음, **펀딩은 DELISTED 심볼도 동결 mark로 계속 정산**(funding.scheduler.ts:48-53) | 부팅 시 "DB TRADING ⊆ 엔진 lane" 대사 assert(fail loudly) + 디리스팅 플로(HALT→CO 스윕→정산→DELISTED) + 펀딩·청산 status 필터 | XS-S / M |
| H5 | **net-worth 스냅샷 크론 — futures API 루프에서 전 Wallet 풀스캔 + 유저별 직렬 upsert, 매 부팅 즉시 실행** | net-worth-snapshot.service.ts:50-101 — 부트 복구·정산 드레인과 정면 경쟁(#21/#22 창 확대), 유저 수와 무한 성장. C1 호그 목록 누락분 | M1 분리 대상 편입 + 배치화(groupBy 1쿼리, createMany) | S |
| H6 | **cancel 경로 2결함** | ① cancelAllOpen이 주문별 순차 await(M건=M×produce RTT) — 사고 드레인 도구가 정확히 이 경로 ② 재취소 무중복가드 — 같은 주문에 CO 무한 발행+엔진 침묵 no-op = #22 실측 CO 스팸 100:1의 BE측 원인. **#17의 `cancelRequestedAt` 스키마 1건으로 #17+#22+A14 동시 봉합** (유저 결정 게이트) | ① sendBatch 묶음 ② cancelRequestedAt 영속화+dedup | S |

클린 판정: spot trigger/OCO 설계 견고(#17 외 신규 레이스 없음), WS 구독 레지스트리 누수 없음, 세션/인증 구조 문제 없음.

## G′. 반박 검증 라운드 (별도 포드, 5건 전부 CONFIRMED)

- A1의 프로젝터 부활(L3): 확증 — project()에 워터마크/순서 가드 0, 음수는 로그만, DriftChecker는 SELECT-only.
- A13 gap-grace 영구 스킵: 확증 — 스킵 seq는 워터마크 뒤로 넘어가 재탐침 경로 없음(replayAll만 복구). 뉘앙스: 500ms 시계는 테일러가 갭을 처음 관측한 시점부터(따라잡은 상태에서만 seq 할당 시점과 동일).
- A9① 청산 배리어: 확증 — where절 무스코프(전역), SETTLEMENT_DRAIN_TIMEOUT_MS=10_000, 심볼당 틱당 isolated 1건 or cross 1계정 + busySymbols 스킵.
- A14: 확증 + 상향 (표 참조).
- A6 컨슈머 poison 크래시 루프: 확증 — RpcProxy가 잡긴 하나 rethrow, `connectMicroservice`가 `inheritAppConfig` 없이 호출돼 글로벌 필터 미적용, kafkajs onCrash가 retriable로 보고 같은 오프셋에서 무한 재기동(전 파티션 동반 정지).

## H. 완전성 비평 라운드 — 1차 포드 7기가 놓친 신규 6건

| # | 문제 | 기전·근거 | 해법 | 규모 |
|---|---|---|---|---|
| H1 | **[정합성·심각] futures 트리거 dead-path — spot #3 수정 미이식** | arm(=증거금 잠금) 커밋 후 NO 전송 실패 시 재발화가 claim `'lost'`로 침묵 리턴 → 잠긴 증거금+미전송 stop이 재기동까지 고착(futures-trigger.service.ts:83-88,140-153). 폭락장(=stop 몰리고 실패 확률 최대)에 직격. A7 스윕은 armed-stop 미커버 | spot `redriveArmedNo`(trigger.service.ts:115-129) 패턴 그대로 이식 | XS |
| H2 | **[TPS·심각] kline — 캔들 저장 0, 매초/매요청 O(버킷 전체) 재집계 + array_agg 실체화** | `(array_agg(price ORDER BY seq))[1]`이 버킷 내 전 체결가 배열 실체화(kline.service.ts:80-96); WS kline 구독마다 매 1s getKlines 재실행; 1d 버킷 ≈ 수백만 행, `kline_1M`+limit1000 REST 1콜 = 심볼 전 역사 스캔

- refactor-observations #27 → 수정 완료로 갱신(exchange.sh:99-168), #18 헤더 "미해결" → DLQ 활성화로 갱신
- #24에 "runtime fixed / straddle open" 상태 명시 유지, 본 감사의 A3(신규 유실 경로)·A5(펜싱) 관찰 추가 등록 권고
