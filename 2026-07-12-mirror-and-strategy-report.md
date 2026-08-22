# 2026-07-12 — 미러링 재작성 · KRW 틱 정렬 · 전략 테스트 리포트

> 이 세션의 목적(유저): 스캘핑/HFT 전략의 **실효성 테스트**가 가능한 수준으로 미러 충실도를 끌어올리고,
> 그 위에서 전략들을 실제로 돌려본다. 볼륨 충실도보다 가격·타이밍 충실도가 우선.

## 1. 메이커 증분 미러 재작성 (feedback-027)

교정: "bids/asks를 한꺼번에 넣고 한꺼번에 빼는 배치 갈아끼우기는 미러링이 아니다."

| 문제 (구 구현) | 수정 |
| --- | --- |
| 1.5s 타이머 배치 → 매 패스 전 레벨 웨이브 | 이벤트 드리븐 + 150ms 페이싱, 패스당 사이드별 15레벨 캡(터치 우선) — 큰 이동도 여러 패스로 "걸어감" |
| bids 전부 처리 후 asks → 상승 시 자가 체결 | 취소(양사이드) 전부 완료 후 배치 + **POST_ONLY**(크로스 시 엔진이 거절) — 자가 체결 구조적 차단 |
| 부분체결 잔량 방치 | 5s open-orders 재동기화(잔량 보충·PO 거절 팬텀·유실 주문 정리) |
| ccxt `limit=N` 구독 → 시드 얕아 북 꼬리 부패(±10% 밴드 거절의 원인) | **풀북 구독** 후 상위 N 슬라이스 |
| 남의 먼지 주문($5.8)이 POST_ONLY 미러 전체를 교착 (실사례: 북이 실세가 +0.4%에 동결) | taker가 먼지 레벨(≤2×minNotional) 통째 흡수 + maker가 매 패스 엔진 실측 터치 확인, 외부 주문이 타깃 범위에 끼면 해당 사이드 홀드(빈 호가 대신 스테일 유지) |
| 20레벨 유지 (급변 시 창 전체 밀림) | **50레벨**(Binance 풀북), Upbit은 전용 raw WS `.30` 구독으로 venue 최대 30레벨 |

**측정 충실도** (타이밍 조임: taker 터치폴 250ms / TPS 20 / maker 150ms):
- 최우선호가 편차 vs Binance: **median 0.00bps / p99 0.22bps / max 0.52bps**
- 완결 1분봉 5개 H/L/C 편차: **전부 0.00bps** (차트 사실상 일치 — 꼬리 깎임·버킷 밀림 해소)
- 자가 체결 0 / `npm run fidelity`: 전 심볼 |mid 드리프트| 0.0bps, depth 96%, 김프 Δ≤0.1bps

한계(시뮬 특성): 서브-150ms 마이크로스트럭처는 미러의 리듬(그 이하 주기 전략은 아티팩트 과적합),
시장 충격 비현실(먹힌 유동성을 미러가 재충전), 급변 순간 극값은 ~150-300ms 추적 한계만큼 이탈 가능.

## 2. KRW 호가단위 실제 업비트 정렬 (관찰 #19 해소)

BE `libs/shared/.../krw-tick.ts` + bots `krw-ticks.ts`를 **docs.upbit.com 공식 표**로 교체
(구간별 라이브 오더북 실측 교차검증). 교정: [1k,5k)→1 (기존 5), [5k,10k)→5, [50k,100k)→50 (기존 10),
[100k,500k)→100 (기존 50), [500k,1M)→500 (기존 100), ≥1M→1000 (기존 [1M,2M) 500) + 저가 꼬리를
0.00000001까지 확장. minNotional 5,000 KRW는 이미 일치. BE spec 갱신(6/6 pass).

적용 후: **USDTKRW 스프레드 33.5bps → 6.7bps = 실제 업비트와 정확히 일치** (1493/1494 동일 호가),
30레벨 유지, 전 심볼 mid 드리프트 0.0bps.

## 3. 전략 테스트 결과

### 3-1. 스캘핑 6종 (5분 병렬, 격리 서브계정 — 틱 정렬 전)
| 전략 | 체결 | PnL | 해석 |
| --- | --- | --- | --- |
| imbalance (테이커, tp2/sl4bps) | 42 | −16.80 USDT | 손실 ≈ 수수료 |
| emacross (테이커) | 39 | −11.33 USDT | 손실 ≈ 수수료 |
| momentum (테이커) | 7 | −2.78 USDT | 손실 ≈ 수수료 |
| meanrev (테이커, 3bps 딥) | 0 | 0.00 | 미발동 |
| maker BTCUSDT (터치 스프레드) | 0왕복 | −0.01 | 미러 큐 지배로 유휴 |
| maker USDTKRW (팽창 틱 시절) | 0왕복 | +134 KRW | 미실현 재고 마크 노이즈 |

### 3-2. 위험수익 전략 (15분 병렬 — 틱 정렬 후, 오더북 뎁스 기반·비HFT)
| 전략 | 체결/왕복 | PnL | 해석 |
| --- | --- | --- | --- |
| **grid BTCUSDT** (0.1% 간격 8단, 20만) | 소수 체결 | **+0.04 USDT** | 조용한 장 — 진동 부족 |
| **grid ETHUSDT** (0.15% 간격 8단, 20만) | 다수 체결 | **+15.74 USDT** (+0.008%/15m) | 진동 수확 성공, 재고 1.50 ETH |
| imbalance 스윙 (tp30/sl20bps, 1s 폴) | 141 | −138.76 USDT | 신호 무에지 — 수수료+슬리피지 |
| meanrev 스윙 (8bps 딥, tp25/sl15) | 11 | −7.29 USDT | 소폭 손실 |
| maker USDTKRW (**정렬 후 재검증**) | 0왕복 | **−266.91 KRW** | **틱 팽창 엣지 소멸 확인** — 수익지점=충실도 이탈이었음이 실증됨 |
| (참고) 유저 장기 grid BTCUSDT d13695 | 09:42~ 계속 | **+1,725 USDT** (+0.17%/7.6h) | 0.2% 간격, 재고 0.83 BTC — 진동 수확 + BTC 방향 노출 |

### 결론
- **테이커 스캘핑**: 수수료 왕복 20bps > 어떤 tp 목표 — 구조적 손실. 활발할수록 더 잃음(정직한 집행의 증거).
- **그리드(메이커·위험수익)**: 유일하게 일관된 플러스. 수익원 = 진동 수확이며, 대가는 **재고(인벤토리) 리스크**
  — 추세 하락장이면 물린 재고로 손실 전환되는 진짜 "위험수익" 구조.
- **무위험처럼 보이던 수익(팽창 틱 메이커)**: 충실도 정렬과 함께 소멸 — "수익이 나면 먼저 충실도/정합성을
  의심한다"는 규율이 다시 실증됨.
- **정합성**: 스캘핑 90체결 + 스윙 152체결 + 그리드 부하 후 정지·드레인 측정 **F1~F4 전부 PASS, 0 monetary
  fail** (라이브 중 측정한 F1b/F4 red 2건은 정지 후 소멸 — in-flight 노이즈, feedback-026 프로토콜 재확인).

## 4. 문제로 파악된 것 (심각도 순)
1. **[미해결→이번에 수정 착수] 정산 워커 poison FIFO 차단** (관찰 #18) — 불량 이벤트 1건이 정산 전체 정지.
   → 유저 승인으로 DLQ(격리 상태 + 별도 테이블 + 에러 로그) 구현 진행.
2. **[수정 착수] 심볼당 200 open-order 캡을 미러가 스침** (재시작 과도기·고churn) →
   시장조성 계정(rateLimitExempt) 캡 상향 진행.
3. **[수정 착수] crash된 전략의 잔여 주문이 미러 교란** (오늘 $5.8 먼지 교착 실사례) →
   잔여 주문 일괄 청소 도구 + 에이전트 기본 거래량 소액화 진행.
4. (수용) Upbit WS 간헐 6s 침묵 → REST 폴백 자가 치유 / USDTKRW qtyPrecision 4 vs 실제 8 (사소) /
   관찰 #17 취소 레이스 (윈도우 좁음, 스키마 변경 필요라 보류).

## 4-1. 사고 기록 (17:26–17:52, 자가 유발 — 투명성 기록)
승인 항목 구현 중 두 건의 사고를 냈고, 둘 다 원인 규명·복구·재발 방지까지 완료:
1. **DLQ 배포가 엔진 아웃풋 컨슈머를 ~25분 정지시킴**: 최초 구현이 `SettlementEvent.attempts`
   컬럼을 추가했는데, Prisma client는 모델 전 컬럼을 SELECT/RETURNING하므로 마이그레이션 전
   client 재생성만으로 기존 `settlementEvent.create/findMany`가 전부 깨짐 → 체결/취소가 DB에
   미반영(주문 접수는 정상). **복구**: 스키마를 "신규 테이블·enum 값 추가만"으로 재설계(기존 모델
   불변), 실패 카운트는 워커 인메모리, DLQ 미적용 시 강등 모드. 컨슈머 재개 후 백로그 완전 드레인.
   교훈은 ADR-067에 기록: 기존 모델 컬럼 추가는 pre-migration 배포에 절대 안전하지 않다.
2. **cleanup 도구 v1이 라이브 grid(d13695)의 사다리 240주문을 취소**: "crash된 전략"과 "agentd가
   관리 중인 라이브 에이전트"를 구분하지 않은 설계 결함. **수정**: agentd `/agents` 조회로 running
   서브계정 제외 + 데몬 미접속 시 `agent:*` 라벨 전체 보수적 제외(재실행 검증: 0건 오취소).
   **복구 준비 완료**: 취소된 240건(BUY, 62865.80~63833.03, 전부 현재가 아래)의 가격·잔량을 DB
   원장에서 추출(`scratchpad/grid-ladder.json`), 원장 그대로 재배치하는 스크립트까지 작성했으나
   **라이브 서브계정에 주문을 넣는 행위라 자동 실행이 차단됨 — 유저 승인 대기** (아래 "남은 액션").

## 5. 변경 파일 (오늘, 미커밋)
- **bots**: `bots/maker.ts` `bots/taker.ts` `feeds/ccxt-feed.ts` `feeds/upbit.ts` `krw-ticks.ts`
  `exchange.ts` `types.ts` `config.ts` `.env(.example)` `README.md` (+`ws` 의존성)
- **BE**: `libs/shared/src/constants/krw-tick.ts`, `apps/spot/.../order-validation.spec.ts`
- **docs**: `docs/feedback/027-mirroring-is-incremental.md`(신규), `docs/specs/refactor-observations.md`(#19 해소),
  `docs/adr/067-settlement-dead-letter-queue.md`, `docs/adr/068-market-maker-order-cap.md`(신규)
- **승인 항목 구현**: ① 정산 DLQ(spot·futures 워커 + `SettlementDeadLetter` 테이블 + F5 체커,
  마이그레이션 전 강등 모드) ② MM 캡 상향(`MM_MAX_OPEN_ORDERS_PER_SYMBOL=2000`, spot/futures/OCO)
  ③ agents `npm run cleanup`(라이브 에이전트 제외) + obook/maker 기본 주문 소액화(100 USDT / $14 상당)
- 실행 노브: `DEPTH_LEVELS=50`, `RECONCILE_MS=150`, `RESYNC_MS=5000`, `TAKER_MAX_TPS=20`

## 6. 리셋 (18:10, 유저 지시) — 새 전략 테스트 환경
전체 리셋: 봇·agentd·스택 정지 → **docker 볼륨 포함 초기화**(Postgres + Kafka — 엔진 state 토픽의
좀비 주문 방지) → `migrate deploy` + `db seed`(102 티커) → 스택·미러(5심볼)·agentd 재기동
(전부 세션과 분리된 nohup 프로세스, 로그 `logs/`).
- grid d13695 사다리 복원 건은 리셋으로 소멸(서브계정 자체가 사라짐). 사고 기록·복원 스크립트는
  `scripts/incident-2026-07-12/`에 보존.
- agents 이전 데이터는 `bitshuriken-prod-agents/data.bak-2026-07-12-pre-reset/`에 백업.

### 새 전략 테스트 퀵스타트
```bash
# 상태 확인
cd bitshuriken-prod-agents
npm run cli status            # agentd (:5120)
npm run cli strategies        # 등록된 전략 (grid / momentum / ...)

# 전략 실행 (전략 1개 = 격리 서브계정)
npm run cli start grid BTCUSDT capital=200000 spacingPct=0.001 levels=8
npm run cli metrics <id> / integrity <id> / stop <id>

# 독립 러너 (오더북 기반, 기본 소액)
npm run obook -- symbols=BTCUSDT signal=imbalance durationSec=300
npm run maker -- symbols=USDTKRW durationSec=300

# 위생 습관
npm run cleanup               # crash 잔여 주문 정리 (라이브 에이전트 자동 제외)
cd .. && ./scripts/check-integrity.sh   # 측정은 정산 드레인 후 (봇 정지됨 — 끝나면 bots 재기동)
cd bitshuriken-prod-bots && npm run fidelity   # 미러 충실도
```

## 7. 남은 액션 (유저)
1. **DLQ 활성화**: `cd bitshuriken-prod-be && npx prisma migrate dev --name settlement-dlq`
   — 적용 전까지는 강등 모드(기존 무한 재시도 동작)로 무해하게 동작. 지금이 적기(fresh DB).
2. 스택/봇/agentd는 nohup으로 떠 있으나, 재부팅 후에는 `./scripts/up.sh` + `npm run bots` +
   `npm run daemon`으로 재기동.
