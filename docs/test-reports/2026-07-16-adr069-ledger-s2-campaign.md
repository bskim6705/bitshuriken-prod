# 2026-07-16 — ADR-069 원장 S0→S2 캠페인 (Wallet 행 락 소멸)

> 오퍼레이터(메인) + Opus 포드 9회분 (F 기반·후속×4 / S·U·P 배선 / X 스위치 / AUDIT / DIAG / A2·L2 수정).
> 유저 확정: §6 4건 (DB append-only 저널 / 저널 커밋 후 응답 / 단일 재시작 / S2까지) + 범위 지시 "wallet row lock만".

## 결론 요약

| 축 | 결과 |
|---|---|
| **Wallet 행 락** | **소멸 (목표 달성).** 핫패스 6지점에서 Wallet UPDATE 제거 — place = 인메모리 reserve(µs) + tx[Order + 저널 INSERT]. 저부하 p50 8ms/p95 35ms(TPS30, 이중쓰기 S0 대비 p95 1/3) |
| **정합성 (failover)** | **전 게이트 통과.** kill -9 드릴 2회(S0: 22,235건 / S2: 31,999건 리플레이) 후 전 지갑 대조 불일치 0. check-integrity 2회 PASS (monetary·parity 0 fail, 최종은 저널 36만행 후). AUDIT 포렌식: 전 63키 seq 재생 running-min 0, lock↔unlock 역전 0, over-release 0 |
| **500 TPS** | **미달.** 병목은 이제 Wallet이 아니라 **be-spot Node 이벤트루프 단일코어** (60 TPS에서 포화 — DIAG 실측). 유효 용량 ≈100~120 TPS(p95<1s), 원시 완주 ≈210~240/s, 500 오퍼 시 혼잡붕괴(타임아웃 폭주→81). pg·풀·엔진(4%)은 전부 여유 |

## 성능 수치 (M1 Mac, 미러 BTC·ETH 동반, 16계정)

| 측정 | 달성 | p50 | p95 | 비고 |
|---|---|---|---|---|
| TPS 30 (S2 스모크) | 30 | 8ms | 35ms | 에러 0 — 락 제거 직접 효과 |
| TPS 60 (DIAG) | 60 | 8~22ms | ~182ms | **be-spot CPU 이미 98~142%** |
| TPS 120 (DIAG) | 120 | 35ms | 674ms | 무릎 구간 |
| TPS 240 (DIAG) | ~215 | 1.7s | 2.6s | 원시 상한. 엔진 3%, pg 유휴 커넥션 25+ |
| TPS 500 (게이트) | 81.5 | 3.4s | 6.5s | 혼잡붕괴 (timeouts 1,222) |

요청당 pg 왕복 ~13~15 (인증 4.5 + Order 7.3 + 저널 ~2 + 정산) — 전부 단일 이벤트루프의 Prisma JS 비용. DIAG 원자료: 세션 스크래치패드 step-*.log.

## 발견·수정 (전부 워킹트리 미커밋)

1. **JournalTailer 스코프 fetch 결함** — 소유 마켓 필터가 타 마켓 seq를 결번으로 오인 → 틱당 1seq 전진 + O(전체 저널)/틱 재스캔 (futures 워터마크 9 고정 실측). **수정**: 언스코프 fetch + 전역 워터마크 + 멀티라운드. 이후 **2단 fetch**(헤더만 경량 fetch, 자기 행 full-fetch 0)로 기생 부하 O(외부 유입)화 (L2).
2. **`[ledger-negative]` 캐치업 아티팩트** — 리플레이/캐치업 창의 torn 관측 순간에 필연 발화 (500 런에서 3,643건). AUDIT 포렌식으로 **양성 확정** (내구 저널은 seq 재생 시 음수 딥 0). **수정**: steady-state에서만 error 승격. 관찰 #25류 영구 누수의 올바른 계기는 lock-unlock 대사 + running-min 스캔 (AUDIT A2/A3 쿼리).
3. **`touchLastUsed` 침묵 사망** — `void` promise에 `.catch` 부재로 풀 기아 시 P2024 reject를 통째로 삼킴 (46k 요청 동안 UPDATE 0건 실측). **수정**: 키당 60s 스로틀 + catch→warn (A2).
4. **드리프트 체커 핫키 오탐** — 프로젝터 랙만큼 항상 순간 차이 → **same-key+same-diff 2틱** 판정으로 보정.
5. **인증 패스트패스** (A2): apiKey 레코드+복호화 secret 캐시(TTL 10s), user authContext 캐시(5s)로 가드↔서비스 이중 read 제거 — 요청당 pg 읽기 ~4.5→~0, AES decrypt 0. revoke 전파 ≤TTL (코드 주석 명시).
6. **프로젝터 배치화** (L2): dirty 키 순차 await upsert → 단일 tx 배치.

## 미결·다음 사다리

1. **500+ TPS = M1 (정산·컨슈머 프로세스 분리)** — 남은 기계장치(out 컨슈머·정산워커·테일러·프로젝터)를 API 이벤트루프 밖으로. 원장은 API 프로세스(reserve 동기성), 정산 프로세스는 저널 append, API 테일러가 적용(≤250ms 랙). 그 다음이 API 수평 확장(P4, 원장 샤딩 선행 — tps-and-failover-plan.md §5).
2. **§6-3 저널 스냅샷** — 부트 리플레이가 이미 33만행(수 초). 저널 성장에 따라 스냅샷 테이블 필요.
3. **S2b portal 콜드플로우** — 이체/출금 조건검사가 프로젝션(≤1s 랙) 기준인 알려진 창. 소유 앱 적용 시점 검사로 봉인 예정.
4. futures 정산 self-trade 동일 이벤트 레그 순서 완화 1건 (X4 문서화), stuck NEW 주문 29건(드릴 다운 창의 취소 유실 — 실주문, 정리 대상), futures 워커 S2 전용 유닛테스트.
5. WALLET_NOT_FOUND가 INSUFFICIENT_BALANCE로 접힘 (API 계약 미세 변화 — X4).

## 추가: DIAG-2 CPU 프로파일 + FIX-1 avgPrice5m 증분화 (같은 날 오후)

**DIAG-2** (V8 inspector 라이브 attach, TPS120 부하 중 50s, 86,228 샘플): 단일코어 포화의 최대 단일 소비처는 **avgPrice5m가 주문마다 5분 트레이드 창 전체를 Decimal 재합산하는 O(N²)** — busy CPU ~17% + GC 8%의 주범. Prisma 직렬화 ~29%(대체로 내재), Decimal.js 16%, kafkajs 5%, **HMAC 0.5%(기각)**. pg 왕복은 I/O라 CPU 무관 — "왕복 13~15 JS 비용" 초기 진단은 정정. 정산워커 leg 문자열 중복 파싱(3~4×/leg), place 인터랙티브 tx ALS 오버헤드, assertTradable 상시 SELECT가 차순위. 프로파일: 세션 스크래치패드 `be-spot.cpuprofile`.

**FIX-1** (avgPrice5m 증분화만 적용, `ticker-stats.service.ts` +40/−14): State에 5분 롤링 qtySum/notionalSum + `avg5mHead` 유지, evict5m(24h evict보다 선행 — 순서 버그를 신규 spec이 검출)·빈창 정확-0 리셋. jest 40스위트/407 green(+8), check-integrity PASS, S2 스택 재배포.
- **재측정 (클린, 미러 동반)**: TPS120 — 초반 20s 목표 유지 후 유효 ~75~100로 퇴화, p95 3~4s, 에러 125(=Prisma tx-start 타임아웃), CPU 95~199% (**미회복**). TPS240 — **초반 30s 240 완주**(수정 전 상한 ~215) + 캐치업 버스트 261~272/s = 원시 상한 소폭 개선 신호, 후반 진동+타임아웃 44. **판정: 수정은 정확·가동 중이나 단독으로는 천장 불변** — 잔여 busy(Prisma 29%·GC·node 내부)가 코어를 계속 채움. DIAG-2 전망(top-3 동시 적용 시 300~350)과 부합; 단일 런 노이즈(미러 웜업·잔여 주문 48·저널 1.03M seq 성장)로 15~20% 델타는 분해 불가.
- **부수 발견 → 관찰 #27**: exchange.sh kill/탐지 패턴이 BE 실제 argv와 불일치 — **재빌드가 배포되지 않는 함정** (구 프로세스 서빙 + 검증 통과). **관찰 #28**: loadtest 셧다운 드레인 무타임아웃 행 → 측정 오염.

## 상태 (세션 종료 시점)

- 스택: 가동 (BE×3 S2 코드, 엔진×2, FE). `LEDGER_TRUTH=true` (롤백 = ledger-truth.ts 1줄 + 재빌드, quiesce 창 권장).
- 마이그레이션: `20260716003124_balance_journal` 적용됨 (DLQ 스키마 동반 활성화, 핫픽스 인덱스 정식 편입 — **reset 후 인덱스 재생성 레시피 폐기**).
- 테스트: 전체 jest 399/399 green (futures-trading MM-cap 기존 실패도 A2가 스텁 보정).
- 미커밋: BE(ledger 모듈 전체 + schema + S/U/P/X/A2/L2/F 수정 + 신규 spec 다수), docs. 커밋은 유저 지시 대기.
