# TPS·Failover 계획 — Redis / 쿼리 최적화 / RTT / 멀티인스턴스 (2026-07-15)

> **Status: Draft — §8 유저 결정 대기. 계획만, 구현 없음.**
> 조사: Opus 포드 3기 (A: BE 핫패스·쿼리 / B: 인프로세스 상태 센서스 / C: Kafka·엔진·인프라) + 오퍼레이터 스팟체크 7건 확증.
> 근거 문서: 관찰 #21~#25 (refactor-observations.md), ADR-012/014/024/034/060/062/063/067/069, handoff-2026-07-14-2.
> 원칙: 정책 결정은 유저 확정 후(feedback-016), prod는 실거래소 기준(feedback-024), 검증 안 된 코어 위에 미리 쌓지 않기(feedback-019).

## 0. 현재 위치 (실측 + 코드 사실)

**처리량 기준선 (07-14 matrix v3, 미러 동반):** 균형 상한 ≈ **100~150 TPS**, 접수 ~200 (피크 280 write/s), 드레인 235/s, spot 100 TPS에서 p50 198ms / p95 1.3s. 부하 중 정산 전이 33/min까지 기아. 엔진은 BE 붕괴 중에도 CPU 2.6% 유휴 — **병목은 BE·DB이지 엔진이 아니다** (관찰 #23).

**구조 천장의 정체** (관찰 #23, ADR-069 Context): ① 잔고가 "DB 행"이라 Wallet 행 락에 직렬화 (수술 ①②③으로 완화, 구조 잔존) ② 주문 1건 = PG ACID 쓰기 ~10회 ③ Node 단일 프로세스 CPU ④ 부하 중 정산 컨슈머·워커 기아. → 300~500 TPS가 현 구조의 천장, 그 이상은 ADR-069(인메모리 원장+저널)가 확정 방향.

**Failover 현주소 (포드 감사 요약):**

| 항목 | 사실 | 출처 |
|---|---|---|
| 그레이스풀 셧다운 | **3앱 전부 전무** — `enableShutdownHooks`/시그널 핸들러 0건, `onModuleDestroy`(producer/consumer disconnect)는 죽은 코드. 모든 재기동 = 무드레인 강제종료. #21/#22의 코드 레벨 기전 | B3, 스팟체크 확증 |
| #21 원자성 갭 | 컨슈머 오프셋 autocommit ↔ DB 반영 사이 원자 배리어 없음. sourceKey unique + PENDING→APPLIED claim 두 멱등 가드에만 의존 (order.status는 컨슈머가, executedQty는 워커가 → 부분 반영 창) | B2 |
| #24 straddle 갭 | 엔진 종결-id FIFO(레인당 50k)가 **스냅샷에 미포함** (snapshot.py:27-43는 seq·offset·bids·asks만) → 재기동 걸친 중복 NO는 여전히 팬텀 체결 가능. 코드로 확정 | C2 |
| SPOF | kafka 1브로커(RF=1)·postgres 1대·nginx 1대. 앱 티어 healthcheck 전무 → hung-but-alive는 자동복구 없음 (#22 ZEC 레인이 산 증거) | C4/C5 |
| 엔진 | 유일한 완성형: WAL(in 토픽)+스냅샷(30s, compacted)+bounded replay+BE 멱등 흡수 (ADR-034/063). 수동 assign이라 리밸런스 자체가 없음 | C1/C2 |
| Redis | 어디에도 없음 (compose·package.json 전수 확인). rate-limit store에 "스케일아웃 시 교체" seam만 예약됨 | B4, C4 |

**핫패스 요청당 비용 (수술 ①②③ 반영 후, 웜 캐시 기준):**

| 경로 | 비용 | 출처 |
|---|---|---|
| spot place | 가드 2 SELECT(apiKey+user, 무캐시) + 1 async UPDATE(lastUsedAt, 무스로틀) + 검증 3 read(ticker·user 중복·count) + tx 2 stmt(락 홀드=마지막 stmt만) + produce 1(응답 전 await, acks=all) | A1/A2 |
| futures place | 가드 동일 + 검증 **6 read**(+position·cross-liq count·maxNotional findMany) + tx 2 stmt + produce 1 | A1/A2 |
| 정산 컨슈머 TR | ≈3 쿼리 — 중복 ticker read(메타는 이미 인메모리) + Trade/SettlementEvent INSERT tx + **비-OCO에도 매번 OCO findMany** | A3 |
| 정산 컨슈머 OU | ≈3 쿼리 — order read + **lastFillOf Trade 역조회 잔존**(인덱스 후 1.3ms, 왕복은 잔존) + status write | A3, 스팟체크 |
| futures 정산 워커 | 이벤트당 **15+ statement**, EP·flip·RPNL이 FOR UPDATE로 읽은 현재 상태에 의존 → 델타 비가환, 배치 불가 **확정** | A3 |

---

## 1. 방향 요약 — 4관점 즉답

1. **Redis: 불채용 권고** — 지금도, 멀티인스턴스(P4)에서도 필수 아님. 후보 용처 전부에 무-Redis 대안(Kafka 브로드캐스트/DB)이 있고, 잔고 원장으로는 ADR-069와 충돌하므로 금지. 재평가 트리거만 명시 (§2).
2. **쿼리 최적화: ADR-069와 직교인 10건 즉시 착수 가능** — 인증 3, 검증 2, 정산 컨슈머 3, 인덱스 2. Wallet 락 경로는 추가 투자 금지 (§3).
3. **RTT: 3층 사다리** — (a) 요청당 왕복 제거(§3와 동일 항목) → (b) 전송·프록시 정비(producer idempotence, nginx keepalive) → (c) 구조(P3 원장: place=메모리 예약+저널). 잔고 가시화 100ms tick은 원장 프로젝터가 재정의하므로 지금 투자 금지 (§4).
4. **멀티인스턴스: "파생은 복제, 효과는 단일 소유"로 컨슈머 2계급 분리 후 API만 수평 확장** — 전제는 그레이스풀 셧다운. 엔진은 이미 유휴라 분할 보류. wallet 샤딩은 계속 안 함(ADR-012 유지) (§5).

Failover는 별도 워크스트림 F0~F5 (§6), 실행 순서는 P0~P4 (§7).

---

## 2. Redis 도입 여부 → 불채용 (조건부 재평가)

| 용처 후보 | Redis 안 | 무-Redis 대안 | 판정 |
|---|---|---|---|
| rate-limit 공유 카운터 | Redis INCR (ADR-060이 `RateLimitStore` seam 예약) | 현재 enforcement **OFF**(ADR-060 Phase 1). 켜더라도: 한도를 인스턴스 수로 나눠 배분(N-분할) 또는 PG atomic upsert | **불필요** — enforcement를 켜고 정밀 전역 한도가 필요해질 때만 재평가 |
| user-data-stream fanout (ADR-024가 "Redis pub/sub 등" 예고) | pub/sub | **Kafka 브로드캐스트 토픽**(`be.user-events`, 인스턴스별 groupId) — 각 인스턴스가 전량 소비 후 로컬 소켓에만 전달. 신규 인프라 0, sticky 불필요 | **Kafka 우세** |
| listenKey 공유 | Redis TTL | DB 테이블 (Session과 동형: expiresAt + sweep) | **DB 우세** |
| 세션 active 판정 | Redis 캐시 | 이미 DB 진실 + 프로세스별 30s 캐시로 **3앱 교차 동작 중** (session.service.ts) | **기존 유지** |
| 잔고 원장 | Redis 원장(Lua 원자 예약) | ADR-069 인메모리 원장 + append 저널 (확정 방향) | **금지** — Redis 원장은 이중 진실·dual-write hazard·핫패스 네트워크 왕복 추가. ADR-069와 정면 충돌 |

**판정 근거**: 이 시스템의 패턴은 "Kafka=WAL, 인메모리=상태, 스냅샷=복구"로 수렴 중이다 (엔진 검증 완료, 원장이 이식 예정). Redis는 이 축에 세 번째 상태 저장소를 추가해 SPOF·운영 부담·정합성 표면만 늘린다. 시뮬 거래소 규모에서 위 대안들의 성능은 충분하다.

**재평가 트리거** (하나라도 발생 시 ADR로 재상정): ① rate-limit enforcement ON + 전역 정밀 한도 요구 ② user-stream 전달 p99를 수 ms로 조여야 하는 요구 ③ 읽기 캐시 계층 통합 수요 (예: FE 폴링이 REST 읽기 병목화).

---

## 3. 쿼리 최적화 (전부 ADR-069 생존 판정 — 원장 전환 후에도 유효)

우선순위순. 효과는 POD A 감사 기준.

| # | 항목 | 위치 | 내용 | 효과 |
|---|---|---|---|---|
| Q1 | apiKey `lastUsedAt` 무스로틀 UPDATE | api-key.service.ts:199 | session lastSeenAt처럼 N초 스로틀 | 요청당 write 1 → ~0. 고TPS 봇 키의 핫행 UPDATE·WAL·풀 점유 제거 |
| Q2 | ApiKey 레코드 무캐시 read | api-key.service.ts:137 | 짧은 TTL 캐시(revoke 시 무효화). HMAC decrypt도 함께 캐시 | 요청당 awaited SELECT 1 제거 |
| Q3 | user 이중 read (가드 + assertCanTrade) | api-key-only.guard.ts:125, user.service.ts:64 | 가드가 로드한 user를 req.user로 전달해 재사용 | 요청당 SELECT 1 제거 |
| Q4 | assertTradable 매 place ticker read | ticker-stats.service.ts:256 | status 단TTL(1~5s) 캐시 또는 control 토픽 무효화 | place당 SELECT 1 제거 (halt 반영 ≤TTL 지연 수용) |
| Q5 | lastFillOf 제거 | match-event-orchestrator.ts:117,171 | TR→OU에 fill 디테일 탑재 (엔진 메시지 계약 변경, ADR-069 병행작업 목록에 이미 명시) | OU당 SELECT 1 제거 + 컨슈머 처리량↑ |
| Q6 | handleTrade 중복 ticker read | match-event-orchestrator.ts:37 | 인메모리 metaOf로 대체 | TR당 SELECT 1 제거 |
| Q7 | 비-OCO trade의 OCO findMany | match-event-orchestrator.ts:63 | orderListId 힌트로 조건부 스킵 (설계 검토 필요) | TR당 findMany 1 제거 |
| Q8 | futures place 검증 왕복 축소 | futures-trading.service.ts:97-178 | count+maxNotional 병합, cross-liq 인메모리 플래그화 | futures place 6→~3 read |
| Q9 | futures 워커 drain 인덱스 | schema.prisma (`[status,createdAt]`만 존재) | `@@index([status, seq])` 추가 | 백로그 모드 정렬 비용 제거 |
| Q10 | lockPosition 2왕복 통합 | futures-settlement.worker.ts:653-663 | CTE로 INSERT-or-lock 단일화 (검증 부담 있음, 후순위) | futures 이벤트당 1왕복↓ |

저우선 (측정 후): 주문 history `[userId,mkt,createdAt]`, myTrades executedAt 정렬 인덱스.

**금지 목록** (버려질 곳에 공수 금지): Wallet 락 경로 추가 최적화(수술① 이상 — ADR-069가 대체), TR 마이크로배치(동일), futures 워커 델타 배치(순서 의존으로 NO-GO 재확인됨).

**동반 작업**: 핫픽스 인덱스 2종의 정식 마이그레이션 (`npx prisma migrate dev --name trade-orderid-indexes`, **유저 실행**, 타 에이전트 DLQ 스키마 +20줄과 조율) — 이게 끝나야 reset마다 수동 재생성 레시피가 사라진다.

---

## 4. RTT 감소

### 4.1 place → HTTP ack (동기 경로)

현재 구성: Nest 파이프라인 + 검증 read들 + place tx(2 stmt) + kafkajs produce await(acks=all·RF1=1브로커 ack) → NEW 응답. 무경합 바닥은 낮은데(수~십수 ms 추정) **부하 시 풀 대기·락 컨보이·이벤트루프가 p50 198ms를 만든다**. 따라서:

1. **§3 Q1~Q4·Q8이 곧 RTT 작업이다** — 요청당 awaited 왕복 3~4개 제거가 가장 큰 지렛대.
2. **전송 정비 (지연 중립~소폭 개선, 신뢰성 동반)**:
   - BE producer `idempotent: true` — 재시도 중복 NO 봉인 (#24의 방아쇠 중 하나가 producer 재시도 중복. 지연 비용 사실상 0)
   - acks 튜닝은 **무의미** (RF=1이라 all≡1브로커) — 손대지 않는다
   - 엔진 out linger(librdkafka 기본 5ms)는 체결 가시화에서 -수 ms 여지 (선택, 측정 후)
3. **프록시/커넥션 (prod 경로)**: nginx `upstream` 블록 + `keepalive` 도입 (현재 매 요청 새 커넥션 — C4 확인), FE/봇 클라이언트 keep-alive 확인. dev는 포트 직결이라 무관.
4. **구조 (P3)**: place = 원장 메모리 예약(µs) + 저널 append — 응답 시맨틱은 ADR-069 §6-4 유저 결정 (append 확인 후 응답 vs 즉시 응답).

목표: P1 완료 시 **부하(300 TPS) p50 < 100ms**, P3 완료 시 **무경합 p50 < 20ms**.

### 4.2 체결 → 유저 가시화 (비동기 경로)

| 하위 경로 | 현재 | 계획 |
|---|---|---|
| executionReport (WS) | 이벤트 구동, 고정 타이머 없음. 부하 시 컨슈머 기아가 지배 | Q5·Q6·Q7로 컨슈머 메시지당 쿼리 3→1 수준으로 — 기아 임계 자체를 올림 |
| 잔고 반영 | 정산 워커 `@Interval(100ms)` + 드레인. 부하 시 초~분 지연 (#23) | **지금 투자 금지** — ADR-069 프로젝터가 재정의. P2 섀도에서 랙 허용치(§6-5) 결정 |
| 마켓 WS (ticker/kline) | 1s 스로틀 (정책값) | 유지. 변경은 유저 결정 사항 |

---

## 5. 멀티인스턴스

### 5.1 설계 원칙 — 컨슈머 2계급 분리

포드 B의 상태 센서스(24종)가 가리키는 단일 원칙:

- **파생 상태 (복제무해)**: orderbook 캐시, ticker stats, mark price, futures config, 세션 캐시 — 진실이 Kafka/DB에 있고 read-only 파생. → **인스턴스별 고유 groupId로 전량 소비(브로드캐스트)**하면 분리 뇌가 "복제"로 바뀐다. 현재 shared group이라 파티션이 갈라지는 게 문제의 전부다.
- **효과 상태 (단일 소유 필수)**: 정산 적용, order status 전이, 트리거 발화, OCO 전이, 컨트롤의 DB 적용, funding/net-worth cron — 두 번 실행되면 안 되거나 순서가 정합성 조건. → **전용 프로세스(효과 티어)로 분리**하고 shared group 파티션 소유권으로 직렬성 유지.

### 5.2 단계 (M0→M4)

| 단계 | 내용 | 해소되는 블로커 (포드 B B5) |
|---|---|---|
| **M0** | 그레이스풀 셧다운 (§6 F0) — 모든 것의 전제 | 블로커 1 (무드레인 킬) |
| **M1** | **정산 프로세스 분리** — out 컨슈머+워커+DLQ를 별도 프로세스로 (ADR-069가 예고한 "원장 프로젝터가 살 집"). futures 워커 경합·failCounts 분산 문제도 함께 소멸 | 블로커 5 (전역 드레이너 경합) |
| **M2** | **API 티어 수평 확장** (spot/futures/portal 각 N개, nginx LB): ① book/control/stats 컨슈머를 인스턴스별 그룹으로 브로드캐스트화 (상장 meta 불일치도 해소) ② mark price: 단기 = 인스턴스별 전량 소비(파생이므로 복제무해), 규모 시 = 효과 티어가 1s mark 스냅샷을 compacted 토픽으로 발행 ③ 트리거 등록을 소유자에게 전달 — 권고안: place 시 key=symbol 컨트롤 메시지로 효과 티어에 등록 위임 (대안: DB 조회 기반 평가 `[symbol,status,stopPrice]` 인덱스) ④ user-stream: `be.user-events` 브로드캐스트 토픽 + listenKey DB화 → **sticky 불필요** ⑤ rate-limit: N-분할 또는 enforcement OFF 유지 (§2) | 블로커 2 (mark 분리 뇌), 3 (트리거 유실), 4 (user-stream 유실) + 상장 컨트롤·rate-limit |
| **M3** | 엔진 스케일 — config 분할로 버킷 서브셋별 인스턴스 (ADR-013/063이 이미 지원, ADR-034 escalation ③) | **보류**: 엔진은 붕괴 중에도 2.6% 유휴. STW·복구시간이 문제될 때만 |
| **M4** | 원장 토폴로지 — ADR-069 §6-6 유저 결정(단일 재시작 vs active-passive)에 따라 후속 ADR. 유저·자산 버킷 샤딩은 그 다음 단계로 명시적 보류 | (P2~P3와 연동) |

### 5.3 지켜지는 기존 결정

- **ADR-012 유지**: wallet(원장) 샤딩 안 함 — 단일 소유자 + 스탠바이가 우선, cross-user trade가 본질이라 샤딩은 마지막 수단.
- id·파티셔닝은 이미 멀티인스턴스 안전 (uuid/DB autoincrement seq/결정적 sourceKey/FNV-1a — 포드 B B4 확인). **여기는 작업 불필요.**

---

## 6. Failover 내성 워크스트림 (F0~F5)

| # | 워크스트림 | 내용 |
|---|---|---|
| **F0** | **그레이스풀 셧다운 (최우선 전제)** | 3앱 `enableShutdownHooks()` + SIGTERM/SIGINT 핸들러: 신규 HTTP 거부 → 컨슈머 stop(오프셋 플러시) → 정산 워커 tick quiesce(진행 중 tx 완료 대기) → producer/consumer disconnect → exit. `exchange.sh stop`과 계약 일치(현재 외부 kill 감시뿐). #21의 발생 창을 "크래시 시"로만 축소 |
| **F1** | 중복·유실 봉인 | ① BE producer idempotence ON (§4.1) ② 엔진 `_terminated` FIFO를 스냅샷에 포함 — #24 straddle 갭 폐쇄 (관찰 #24가 "소용량 지속화 게이팅"으로 이미 예고; 50k id는 스냅샷 크기 영향 측정 후 cap 조정) ③ **#21 구조 해소는 ADR-069 저널 규율에 위임** — 임시 패치로 오프셋 수동커밋+tx 결합을 만들지 않는다 (저널이 곧 대체할 복잡도, feedback-019) |
| **F2** | 감지 (hung 포함) | ① BE 앱 health 엔드포인트(+DB·Kafka 도달성) ② prod compose 앱 티어 healthcheck 추가 (현재 pg·kafka만) ③ **레인 진행 워치독**: state 스냅샷의 offset(소비) vs seq(처리) 분리 판독으로 #22형 "소비하되 처리 않는" 레인 검출 (07-14 진단 레시피의 스크립트화) ④ stuck NEW>500 알람 (드레인 92s 실증이므로 유입 차단이 대응) |
| **F3** | 인프라 | ① pg_dump 자동화 + 보존 정책 ② Kafka RF=1 수용 여부 유저 결정 (단일 호스트라 브로커 증설 실익 제한 — RPO 목표와 함께 §8) ③ dev(cp-kafka+ZK, 호스트 프로세스) vs prod(KRaft, 컨테이너) 차이 문서 고정 ④ restart 정책 정합(one-shot 제외 전부 unless-stopped 확인됨) |
| **F4** | 드릴 (게이트) | 컴포넌트별 kill -9 매트릭스: be-spot/be-futures/효과 티어/엔진/kafka/pg 각각에 대해 "죽임 → 자동/수동 복구 → check-integrity F1~F5 = 0 fail" 통과해야 단계 완료. ADR-069 Phase S1 게이트(크래시 리플레이)와 통합. 재기동 straddle 중복-NO 시나리오 포함 (#24 검증) |
| **F5** | 운영 도구 | ① exchange.sh 버그 2종 수정 (start가 기존 BE dist 미재시작 / stop·reset 좀비 미정리 — handoff §6) ② 표준 재기동 절차(미러 정지→PENDING=0→재기동→신규 PID 확인)를 스크립트로 승격 |

---

## 7. 실행 단계 (P0~P4)

각 단계는 Opus 포드 위임 + 오퍼레이터 게이트 판정으로 실행 (운영 모델: handoff §포드 운용). **각 게이트 = loadtest(bots/src/loadtest.ts) + check-integrity + kill -9 드릴.**

| 단계 | 내용 | 게이트 (완료 판정) |
|---|---|---|
| **P0 기반** | F0(그레이스풀 셧다운) + F5(exchange.sh 2버그) + Q9(drain 인덱스) + 마이그레이션 정리(유저: trade-orderid-indexes, settlement-dlq 조율) | SIGTERM 재기동 드릴에서 monetary fail 0 (#21 재현 경로로 검증) |
| **P1 전술 TPS/RTT** | Q1~Q8 + §4.1 전송 정비(idempotence·nginx keepalive) + 백프레셔(행별 세마포어+429, 관찰 #23 플랜 ④) + MM 계정 심볼당 분리(봇 설정, F1 대사 수정 동반) + F1·F2 | **균형 300 TPS, p50 < 100ms**, F1~F5 클린, 부하 중 정산 기아 임계 상승 확인 |
| **P2 원장 섀도** | ADR-069 §6 확정(유저) → 저널+원장 병행 가동, F1~F4 3자 대사(저널 리플레이 vs 원장 vs 프로젝션), kill -9 리플레이 게이트 | N일 무드리프트 + 크래시 리플레이 통과 (S1 게이트) |
| **P3 truth 스위치** | 잔고 판정·주문 수락이 원장 기준, Wallet 행=프로젝션, place=메모리 예약+저널 append | **접수 1k+ TPS**, 무경합 p50 < 20ms, 3자 대사 클린 |
| **P4 멀티인스턴스/HA** | M1(정산/효과 티어 분리) → M2(API ×N + 블로커 5종 해소) → M4(원장 topology 후속 ADR). Redis는 §2 트리거 발생 시에만 재상정 | 임의 인스턴스 kill 중 주문 접수 지속 + F1~F5 클린 + RTO/RPO 목표(§8) 충족 |

순서 근거: P0는 모든 재기동·배포의 안전 전제라 최선행. P1은 ADR-069와 직교라 §6 정책 확정을 기다리지 않고 진행 가능. P4의 M1은 P2의 프로젝터 주거지를 겸하므로 P2와 병행 가능.

---

## 8. 유저 결정 필요 (feedback-016)

| # | 결정 | 선택지 / 기본 권고 |
|---|---|---|
| 1 | ADR-069 §6 정책 6건 | 저널 매체 / 내구성 / 스냅샷 주기 / REST 응답 시맨틱 / 프로젝션 랙 / failover 토폴로지 — ADR-069 표 참조 |
| 2 | 목표 수치 | 균형 TPS 목표 (P1: 300 / P3: 1k+ 제안), place p50 (100ms→20ms 제안), RTO(컴포넌트 사망→복구 초), RPO(유실 허용: 0 vs 스냅샷 간격) |
| 3 | Redis | **기본 권고 = 불채용** (§2). 승인 여부 + 재평가 트리거 동의 |
| 4 | Kafka RF=1 | 단일 호스트에서 수용(백업으로 보완) vs 브로커 3노드(디스크·메모리 비용) — RPO 결정과 연동 |
| 5 | P4 토폴로지 | API active-active ×N + 효과 티어 단일(+스탠바이) 권고 vs 전면 active-passive |
| 6 | rate-limit enforcement | 계속 OFF (시뮬 목적) vs 데모 프로파일 ON — ON이면 §2 rate-limit 항목 재평가 |
| 7 | 마켓 WS 1s 스로틀 | 유지(권고) vs 단축 |

## 9. 이 계획이 하지 않는 것

- Wallet(원장) 유저 샤딩 (ADR-012 유지 — 최후 수단으로 보존)
- Redis 원장·Redis 세션 (§2)
- futures 정산 델타 배치 (순서 의존 NO-GO 재확인 — 정직 게이트 유지)
- 엔진 조기 분할 (M3 보류 — 병목 아님)
- Wallet 락 경로 추가 미세최적화, TR 마이크로배치 (ADR-069가 대체)
- 마이그레이션 실행·커밋·재기동 (전부 유저 지시 필요)
