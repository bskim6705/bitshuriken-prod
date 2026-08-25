# 2026-08-25 — 수평 확장(pm2 cluster / k8s) 감사

> 질문: "실서비스라면 pm2 cluster·쿠버네티스로 다중 인스턴스를 띄울 텐데, 그 관점에서 더 최적화할 것?"
> 방법: 병렬 감사 3축 — ① API 앱(spot/futures/portal) 단일 인스턴스 가정, ② 원장·DB 계층, ③ settle·매칭엔진·인프라.
> 경로는 bitshuriken-prod-be/ 기준(타 레포는 접두어 명시).

## 판정 요약
- **spot/futures는 "stateless API"가 아니라 인메모리 엔진이다.** 복제하면 성능이 아니라 **정확성**이 깨진다(§2). 리더 선출·인스턴스 ID·advisory lock·공유 캐시는 레포 전체에 하나도 없음 — 모든 "1회 실행" 보장은 "프로세스가 정확히 1개"라는 사실 하나에 의존.
- **pm2 cluster가 최악의 선택지다**: cluster 모드는 포트 공유가 되므로 기동은 성공한 것처럼 보이는데, §2·§3의 모든 파손이 조용히 라이브가 된다. 경고가 없다.
- 이 시스템의 자연스러운 확장 축은 **레플리카가 아니라 샤드(심볼 버킷)** — Kafka 파티션(FNV-1a % P)이 이미 그 축이고, 엔진·컨슈머·트리거가 전부 심볼 결정적이다. 유일하게 stateless 복제 가능한 앱은 portal(§7).
- 복제와 무관하게 **지금 고칠 것**이 여럿 발견됨(§1) — 특히 프로드 compose에 settle이 아예 없어서 현재 코드로 프로드 배포하면 정산이 전혀 돌지 않는다.

---

## 1. 지금 당장 (복제 이전, 현 토폴로지에서 유효)

### 1a. 프로드 infra가 M1 이전 토폴로지 — 현 코드로 배포하면 파손
- `bitshuriken-prod-infra/`에 "settle" 문자열 0건. `docker-compose.prod.yml`은 be-spot/futures/portal만 정의, `.env.prod.example`에 `PORT_SETTLE` 없음.
- 그런데 M1에서 정산 워커·프로젝터·드리프트는 **settle 앱에만** 등록돼 있다 (spot `settlement.module.ts`는 서비스만 제공, futures `futures.module.ts`는 FuturesSettlementModule 미임포트, API 스케줄러는 tail-only로 절단됨).
- → 프로드 compose로 올리면 **체결 정산·Wallet 프로젝션·드리프트 감시가 전무**. M1이 로컬 exchange.sh 경로에만 반영된 상태. compose에 be-settle 서비스 + PORT_SETTLE + 헬스체크 추가 필요.

### 1b. settle 컨슈머 동시성 절반 스로틀 — OU 랙의 유력 직접 원인 (한 줄)
- `apps/settle/src/main.ts:28-31`: `partitionsConsumedConcurrently = Math.max(6,6) = 6`. 그러나 settle은 4토픽(spot/futures out+control)을 한 컨슈머로 구독 → 할당 파티션 12+2개. kafkajs의 이 값은 토픽별이 아니라 **전체 할당 기준**이라 API 앱(6/6 = 1:1) 대비 절반 비율로 돈다. `max`가 아니라 **합**이어야 함. 사이클3 잔여 "NEW 재고 ~3.5k"의 1순위 용의자.

### 1c. exchange.sh staged stop 순서 버그
- `scripts/exchange.sh:279`의 BE 패턴 `dist/apps/(spot|futures|portal|settle)/main`에 settle이 포함돼 ②단계에서 settle이 API와 동시에 TERM을 받고, ③(settle 단독 정지)은 no-op. "API 먼저 → settle 나중(잔여 정산 드레인)" 의도가 실제로는 실행되지 않음.

### 1d. 즉효 DB 최적화 (settle 처리량 = OU 랙 직결)
| # | 내용 | 위치 |
|---|---|---|
| 1 | `writeManyInTx`가 순차 `await create` 루프 — 스팟 배치 500이벤트×4레그 = **한 트랜잭션 안에서 2000 왕복**. `createMany`로 | `libs/core-domain/src/ledger/journal-writer.ts:83-93`, 호출부 `settlement.worker.ts:208` |
| 2 | TR마다 `ticker.findUnique` — 인메모리 `tickerStats.metaOf`가 이미 있는데 매 트레이드 DB 왕복 | `match-event-orchestrator.ts:38-40` |
| 3 | OCO 무관 트레이드에도 매번 `order.findMany` (OCO 레그 탐색) | `match-event-orchestrator.ts:64-67` |
| 4 | futures TR마다 `feeRatesOf` 2회, OU마다 `lastFillDetail` 2쿼리 — 게다가 futures 쪽 `trade.findFirst`는 심볼 필터가 없고(스팟엔 있음) maker/taker OR가 BitmapOr+정렬 강제 | `futures-match-result.service.ts:58-61,171,220` |
| 5 | futures 정산 폴 `WHERE status=PENDING ORDER BY seq LIMIT 500` @10Hz인데 인덱스는 `(status, createdAt)`뿐 → 매번 정렬. `(status, seq)` 필요 | `futures-settlement.worker.ts:215-220`, `schema.prisma:403` |
| 6 | 최고 삽입율 테이블(BalanceJournal·SettlementEvent)이 UUID v4 PK — 페이지 스플릿·WAL 증폭. 모노토닉 `seq`가 이미 있음. `BalanceJournal.@@index([userId,assetSymbol])`는 읽는 쿼리가 없음(순수 쓰기 비용) | `schema.prisma:389,524,539` |
| 7 | transfers가 **지갑 락 잡은 채** PENDING 전체 `findMany`(무필터·무리밋) + legs JSON을 JS에서 필터 — 백로그가 크면 이체가 느려지고 락이 정산과 경합 | `apps/portal/src/http/transfers/transfers.service.ts:54-62,162-177` |
| 8 | 전 지갑 풀스캔 2종: DriftChecker 30초마다(무select·무페이지, `marketType` 후행이라 seq scan), net-worth 일1회 + **부트마다** `wallet.findMany()` 전건 | `drift-checker.ts:40-44`, `net-worth-snapshot.service.ts:50-59` |
| 9 | `applied` Set 무한 성장 — `forgetApplied` 호출자 0. 부트 이후 저널 sourceKey 수만큼 프로세스 메모리 누적 | `ledger.service.ts:111,202` |
| 10 | BalanceJournal 보존 정책 없음 + `replayAll`이 부트마다 seq 0부터 전체 리플레이 → **부트 시간이 평생 쓰기량에 비례**. 스냅샷(체크포인트) 도입 전엔 truncate 불가 | `journal-tailer.ts:63-91` |

---

## 2. 복제 시 돈이 틀어지는 것 (하드 블로커)

### 2a. 원장 reserve() 이중지출 — 최상위 블로커
- `ledger.service.ts:102-114`: check→hold 사이 await 없음 — 원자성의 증명이 문자 그대로 "Node 단일 스레드"(주석 `:18,:99-100`). 프로세스가 2개면 증명이 소멸.
- S2 경로엔 **DB측 잔고 조건이 전혀 없다**: 주문 접수 = `reserve()` + `$transaction([order.create, journal.create])` (INSERT 2개). 잔고를 검사하는 것은 인메모리뿐. (S0 폴백만 `WHERE balance >= $1` 조건부 UPDATE로 다중 라이터 안전 — `order.service.ts:404-413`, `margin.service.ts:317-329`.)
- 레플리카 간 수렴은 JournalTailer 250ms 폴링뿐 → **≥250ms 이중지출 창**. 저널은 sourceKey 유니크라 "같은 주문"만 디덥하지 "서로 다른 두 주문의 초과 인출"은 통과. 사후 검출뿐(`[ledger-negative]` 로그는 클램프 금지, 드리프트는 30초).
- reserve() 호출부 6곳: spot 주문 `order.service.ts:309`, OCO `order-list.service.ts:217`, futures 증거금 `margin.service.ts:212`, 트리거 스탑 arm `:308`, 마진 추가 `futures-trading.service.ts:608`.
- 파생 문제: tailer의 gap-skip(`journal-tailer.ts:150-169`, grace 2틱)은 지금은 "자기 쓰기는 로컬 즉시 적용"이라 무해하지만, **타 레플리카가 쓴 seq가 늦게 커밋되면 스킵 후 영구 유실**(watermark는 `seq >`만 조회, 재조회 없음).

### 2b. 마크프라이스 포크
- `mark-price.service.ts:57-58,81`: 손제작 kafkajs 컨슈머(그룹 `bitshuriken-futures-index`)가 `match.spot.out` 구독. futures 2레플리카면 이 그룹도 파티션 분할 → 각자 스팟 트레이드의 절반으로 EMA 인덱스 계산 → 심볼별로 `index === null`(영구) 또는 서로 다른 마크.
- 하류 전파: 주문 승인(`futures-trigger.service.ts:109` getMark throw), 펀딩(`funding.scheduler.ts:73`), 청산 재검증(`liquidation.monitor.ts:221` — 클레임은 안전하나 **판단이 포크**: A가 청산하는 포지션을 B는 건강하다고 봄), 순자산, WS 마크 스트림.

### 2c. 펀딩비 비결정
- `funding.scheduler.ts:42-63` @Cron이 전 레플리카 동시 발화. `FundingRate` 유니크로 DB는 보호되지만, **승자 레플리카의 로컬 premiumRing(자기 포크된 마크 기준 부분 히스토리)이 전 거래소의 펀딩비가 된다** — 코인 플립. 패자들은 `drainPremiumSamples`로 8시간 샘플을 파괴적으로 비움.

### 2d. futures 정산 = 순서가 정합성 조건
- `futures-settlement.worker.ts:214-235`: 글로벌 `seq asc` 드레인 + 재시도 대상이면 `break`(포이즌 정지 의도). 클레임은 멱등하나 **순서는 보존 안 됨** — 2레플리카면 B가 seq 11을 A의 seq 10보다 먼저 커밋 가능(포지션 전이 파손). 스팟 워커는 반대로 `FOR UPDATE SKIP LOCKED`라 다중 워커 안전(주석에 명시).

### 2e. settle 2대 금지 (현 구조)
- 프로젝터가 각자 다른 랙의 인메모리 원장에서 **절대값** upsert → Wallet 값이 250ms마다 핑퐁. `settle-ledger.module.ts:9` "단독 구동" 주석이 유일한 방어.
- LEDGER_TRUTH 경로의 shortfall/flip 판단이 자기 원장(FOR UPDATE 없음, `futures-settlement.worker.ts:193-199`)을 읽음 — 레플리카 간 최대 250ms 갈린 원장으로 자금 판단.
- 컨트롤 토픽 1파티션 → 한 레플리카만 신규 심볼 meta 수신, 다른 쪽은 `no ticker meta`로 **OU 통째로 드랍**(`match-event-orchestrator.ts:101-104`).
- `failCounts` 인프로세스 → 격리까지 N×재시도.

---

## 3. 복제 시 기능이 깨지는 것

| # | 파손 | 근거 |
|---|---|---|
| 1 | **listenKey ~50% 거부** — 인메모리 Map("단일 BE 인스턴스 전제" 주석). REST 발급 레플리카 ≠ WS 업그레이드 레플리카 → resolve null → close(4401). keepalive 404, revoke 무동작 | `libs/shared/src/ws/listen-key.base.ts:19,24,68-76` |
| 2 | **체결 알림 소실** — OU 팬아웃은 파티션 소유 레플리카의 로컬 소켓맵 조회. 유저 WS가 다른 레플리카에 있으면 조용히 드랍. 크로스 레플리카 버스 없음 | `user-gateway.base.ts:124-131`, `user-stream.service.ts:63` |
| 3 | **신규 상장 반쪽 인지** — 컨트롤 토픽 1파티션이라 한 레플리카만 수신 → 나머지는 TICKER_NOT_FOUND·WS 구독 거부·OU 드랍 | `topics.ts:16-17`, `ticker-control.controller.ts:25` |
| 4 | **24h 티커·오더북 미러 반쪽** — 심볼→파티션이 고정 해시라 랜덤 50%가 아니라 **심볼 하드 분할**. REST가 라운드로빈되며 값이 두 상태를 플립플롭, `/depth`는 절반 확률 EMPTY_DEPTH | `ticker-stats.service.ts:94,148`, `orderbook-cache.service.ts:43-77` |
| 5 | **트리거(스탑) 취약** — 전 레플리카가 전체 스탑 로드(샤딩 필터 없음), 평가는 심볼 소유 레플리카만 — "우연히" 동작하는 구조. 부트 복구는 클레임 없이 NO/CO 재발행 → N중복 발사(엔진 멱등에 기대는 미검증 가정) | `trigger.service.ts:41-45,151-173`, `futures-trigger.service.ts:194-214`, `order-list.service.ts:640-683` |
| 6 | **레이트리밋 N× 관대** — 로그인·주문 리밋 포함 보안 회귀. 코드가 이미 교체 지점 명시("스케일아웃 시 공유 저장소로 교체") | `rate-limit.store.ts:8-11,39-41` |
| 7 | 청산 MARGIN_CALL 중복 통지·크로스 유저 락 미공유 / FuturesConfig 캐시 TTL 없음(영구 불일치 가능) / 세션·API키 캐시 ≤30s/10s 지연(수용 가능) | `liquidation.monitor.ts:27-32,316-322`, `futures-config.service.ts:8` |

---

## 4. 매칭엔진 — 확장 모델이 아예 없음

- **수동 `assign()`, 컨슈머 그룹 프로토콜 미사용** (`messaging/consumer.py:7-20` — group.id는 있으나 불활성). 파티션은 로컬 config의 lane 목록에서 유도 → **같은 config 2대 = 전 파티션 이중 매칭 + state 스냅샷 상호 클로버**. 펜싱(에포크·리스·소유 토큰) 전무.
- 유일한 방어는 `exchange.sh:236-242`의 pgrep 인스턴스 카운트 — 단일 호스트 전용(22-엔진 스웜 사고가 주석에 기록돼 있음). 멀티 호스트/파드에선 무의미.
- 확장 축은 현재 "마켓 분리"(match-spot/match-futures) 하나뿐. 인스턴스 추가 = config JSON 수동 분할이며 심볼이 두 config에 겹치면 즉시 파손. 부트 시 빈 버킷 파티션은 미할당 → 런타임 상장 심볼이 재기동까지 불활성(`main.py:59-64`).
- **P=6이 6곳에 독립 존재**하고 변수명도 갈림(`MATCH_SPOT_PARTITIONS` vs `MATCH_PARTITIONS`): `partition.ts`, `kafka-init.sh`, `exchange.sh`, `create-kafka-topics.sh`, `admin-ticker.mjs`, config JSON 리터럴.
- 엔진은 HTTP 표면이 0 — k8s liveness/readiness 부착 지점이 없고, restore 스톨(`snapshot_store.py:94-95` RuntimeError)을 프로브가 못 잡는다. 단일 스레드 + GC off는 잘 돼 있음(스냅샷 20ms 초과 경고 존재).

---

## 5. k8s 이행 준비물 (인프라)

| 항목 | 현황 | 필요 |
|---|---|---|
| 헬스 엔드포인트 | `/health`는 settle 유일(그마저 정적 리터럴 — Kafka 랙·원장 미검사). spot은 실비즈니스 쿼리, futures/portal은 /docs로 프로빙 중 | 전 앱 liveness+readiness(컨슈머 연결·원장 가용성 반영), 엔진에 최소 HTTP/파일 프로브 |
| nginx | upstream 블록 없음, `set $u 단일타깃`. WS 2경로는 sticky 필수(listenKey·소켓맵이 프로세스 로컬) | upstream + WS affinity — 단, §3-1이 먼저 풀려야 의미 있음 |
| Kafka | 단일 브로커 KRaft, RF=1, offsets/txn RF=1, heap 512m. **브로커 주소가 단일 원소 배열이라 멀티 브로커 부트스트랩이 코드 수정 없이 불가**(4곳). groupId/clientId 전부 하드코딩 리터럴 | RF≥3, env화 |
| Postgres | 단일, 설정 무변경(max_connections 100), 풀러 없음. 프로드 URL에 connection_limit 없음 → 프로세스당 기본 ~17. dev값 30 쓰면 4앱×30=120으로 **N=1에서 이미 초과** | pgbouncer(+Prisma 플래그) 또는 명시적 connection_limit 산정 |
| 종료 | F0 완료 — BE enableShutdownHooks + 워커 15s quiesce, 엔진 SIGTERM→최종 스냅샷. 단 엔진 drain(`publish_all_dirty`+flush)은 무한도라 terminationGracePeriodSeconds 산정 시 주의 | 워커 15s가 grace 하한 |
| 정책 상수 | groupId·브로커(단일)·tail 250ms·BATCH 500 등은 코드 상수(feedback-020 의도) — k8s화 시 env로 뺄 것과 코드에 남길 것 구분 필요 | — |

---

## 6. 이미 안전한 것 (조치 불요)
- **portal**: 무상태 JWT 쿠키 + DB 세션(30s 캐시 지연은 기수용) + Kafka/스케줄러/WS 없음 → 사실상 지금도 복제 가능. 유일한 진짜 stateless 앱.
- 정산 멱등 사슬(3단 유니크: SettlementEvent.sourceKey → 클레임 updateMany/SKIP LOCKED → BalanceJournal.sourceKey), FundingRate·BalanceSnapshot 유니크/upsert, 청산·트리거의 DB 가드 클레임(이중 발사·이중 청산 방지 자체는 견고), API키 서명(논스 불요 설계), 포트 바인딩(k8s에선 무충돌), env fail-fast.

---

## 7. 권장 경로 (설계 판단 — 유저 확정 필요)

**레플리카(동일 앱 N개)로 가는 길은 이 시스템의 결에 반한다.** 현실적 선택지 두 개:

1. **샤드 확장 (권장 검토 1순위)** — 파티션 버킷을 배포 단위로: spot-shard-{0..P-1}이 각자 자기 파티션의 컨슈머·오더북·트리거·WS를 소유. 심볼 결정적 해시라 nginx도 심볼로 라우팅 가능. 엔진 확장과 동형이라 모델이 하나로 통일됨. **남는 문제는 원장 하나** — 잔고는 유저 단위라 심볼 샤딩과 직교. 해법 후보: (a) 원장 전용 프로세스 분리(reserve를 RPC로 — 레이턴시 비용), (b) S0 스타일 DB 조건부 갱신으로 회귀(TPS 비용 — ADR-069 이전으로), (c) Redis 단일 라이터. 이건 ADR감.
2. **공유 저장소 주입 (부분 복제)** — portal 즉시 복제 + spot/futures는 단일 유지하되 WS 팬아웃만 Redis pub/sub, listenKey·rate limit을 Redis/DB로 → "읽기 전용 레플리카"(REST 조회 전담)만 추가하는 절충. 원장·마크·펀딩은 여전히 단일.

어느 쪽이든 **선행 공통 작업은 §1 전부**(프로드 settle 부재, 동시성 절반, DB 왕복 다이어트, 저널 스냅샷)이고, 이는 단일 인스턴스 성능도 직접 올린다.
