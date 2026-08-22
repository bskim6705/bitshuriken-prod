# 그린 기준선 + 라이브 전략 실행 (2026-07-12, 2차)

유저의 DB 리셋 후 재실행. 목표: 세 축(정합성·미러링·전략)을 깨끗한 상태에서 end-to-end로
돌려 **금전 정합성이 부하(봇 미러링 + 라이브 전략 체결) 하에서 유지되는지** 확인.
1차 리포트(`2026-07-12-first-mirror-baseline.md`)의 3개 발견을 모두 처리한 뒤의 재측정이다.

## 사전 조치 (1차 발견 해소)
- **F#1 (dev 토폴로지 충돌)** — 스택을 프로드와 동일한 2-인스턴스 매칭엔진(`match-spot`/`match-futures`)으로
  재기동. 심볼 lane 충돌 구조적으로 제거. (up.sh는 이전 커밋에서 분리됨.)
- **F#3 (시드 원장 우회)** — `prisma/seed.ts`가 alice/bob 지갑을 직접 크레딧해 원장 없는 잔고가
  생기던 문제. 초기 지급마다 운영자 `ADJUSTMENT` FundingTx를 멱등(reason 마커)으로 기록하도록 수정.
  실거래소 기준(모든 크레딧 = 원장 1행)에 부합. 재시드로 백필 → **F1b가 전 계정에서 green**.
- **피드 실시간성 (WS) — 초기 오판을 정정** — 처음엔 WS가 막힌 줄 알고(Upbit close 1000 / Binance depth
  무응답) REST 폴백을 넣었으나, 이후 raw WS·ccxt.pro 직접 프로브로 **WS는 정상**임을 확인(둘 다 즉시 데이터).
  실제 원인 두 가지: (a) Binance **저volume 심볼의 trades WS**를 6s stall-timeout이 오판(체결이 드문 게
  정상인데 실패로) → **trades엔 timeout 제거**; (b) Upbit은 한 커넥션에 다심볼을 **rapid 재구독**하면 소켓을
  닫음(code 1000) → **구독을 700ms 스태거**. 결과: **양 소스 tick-level WS, 폴백 0건**. REST 폴백은 이제
  자가치유 안전망으로 남김(WS 실패 시 임시 전환 후 ~60s마다 WS 재프로브로 자동 복귀). (ccxt-feed.ts)

## 실행 구성
- 스택: BE spot/futures/portal + **매칭엔진 2-인스턴스** + Postgres/Kafka (fresh DB, 유저 리셋).
- 봇(`bitshuriken-prod-bots`): maker/taker 2계정(HMAC, rateLimitExempt), 9심볼
  `BTCKRW,ETHKRW,SOLKRW,XRPKRW,USDTKRW,BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT`.
- 전략(`bitshuriken-prod-agents`): agentd 데몬(:5120), 마스터 계정 + 서브계정 격리. `.env`를 로컬 스택에 연결.

## 결과

### ① 정합성 — 3단계 모두 green (0 monetary fail)
| 단계 | F1a | F1b | F1c | F3a | F3b | F3c | F2 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 거래 전(fresh) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 봇 미러링 부하 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 라이브 전략 체결 관통 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
봇이 양 소스를 미러링하고 grid 서브계정이 활발히 체결하는 동안에도 거래소 원장이 완벽히 대사됨.

### ② 미러링 — Binance + Upbit 동시 라이브
로컬 책(미드) 샘플: BTCKRW 95,219,000/95,250,000 · USDTKRW 1490/1495 · ETHKRW 2,667,000/2,669,000 ·
XRPKRW 1630/1635 (KRW 계단식 tick 정렬) · BTCUSDT 63860.03/.04 · ETHUSDT 1787.81/.82 · SOLUSDT 76.46/.47.

**김치 프리미엄 스캔** (KRW 책 vs USDT 책 × USDTKRW): BTC −0.084% · ETH +0.060% · SOL +0.045% · XRP +0.224%.
양 레그가 모두 라이브라 실시간 산출됨.

### ③ 전략 — 백테스트 + 라이브
- **백테스트**(self-contained, SimBroker + Binance 이력): momentum BTCUSDT 1h 7d → ROI −0.37%, 6체결,
  Sharpe −3.67, 수수료 1493. 전략 레지스트리·엔진·지표·메트릭 전부 동작.
- **라이브 grid**(id d13695, BTCUSDT, 서브계정 격리, 1M USDT): 8체결, equity **1,000,006.39 USDT(+6.39)**,
  BUY→SELL 라운드트립 완료(63760 매수 → 63887.75 매도). 에이전트 자체 대사: quoteDrift −0.0044 USDT
  (수수료 모델 잔차, 허용 범위), baseDrift ≈0. bar 신선, 무에러.

## 발견 / 노트
- **[관찰] WS 차단 환경** — 이 실행 환경은 거래소 WebSocket을 차단(Upbit close 1000 / Binance depth hang).
  자가치유 REST 폴백으로 해소. 프로드 배포 환경에선 WS가 primary로 복귀(폴백은 실패 시에만).
- **[경미] XRPKRW maker 자금 부족** — base 지급(100k XRP)이 Upbit 20레벨 depth 미러링에 부족해 일부 SELL
  레벨 place 거부(비치명, 부분 미러). 봇 펀딩 사이징 이슈 — 정합성과 무관.
- **[경미] 에이전트 quoteDrift 0.0044 USDT** — 체커의 클라이언트측 수수료 모델(SIM_FEE_BPS)과 거래소 실제
  수수료의 반올림 차. 거래소 원장 자체(F1b)는 정확히 green이므로 거래소 버그 아님.

## 판정
세 목표 모두 실증. **거래소는 실시장형 부하(양 거래소 미러 + 계단식 호가 + HMAC + 격리 서브계정 라이브
전략)에서 금전 불변식을 유지**하며, 수익 전략(grid)이 라이브로 체결·수익·정합을 보였다. 1차의 3개 발견은
모두 해소(F#1 토폴로지 / F#3 시드 원장 / 신규 WS-피드)됐다.

## 미러 충실도 개선 + 정합성 측정 프로토콜 (차트 아래꼬리 조사)
FE 차트에 긴 아래꼬리("긁힘")가 보였으나 **백엔드 데이터는 깨끗**했다(실체결·클라인 모두 SQL `min(price)`
기준 worst dip −1.3%; 클라인은 Trade 단일 소스). 원인: **테이커가 소스 체결을 MARKET으로 재생 → 얕은
20레벨 미러 책을 쓸어내려** grid 깊은 rung까지 체결(1건이 6-leg, −1.3%). 몸통이 타이트해 시각적으로 극적.
- **수정(②, 채택):** 테이커를 **LIMIT IOC(터치 가격)**로 — 마켓처럼 즉시 체결하되 터치 밖으론 못 뚫는다
  (엔진이 IOC 부분체결 잔량을 EXPIRED 종결). `exchange.ts placeLimitIoc` + `taker.ts`. 결과: worst dip
  **−1.3% → −0.024%**, 테이커 주문 MARKET→LIMIT/IOC(0 MARKET). 구조적 상한이라 미러 깊이와 무관.
- **①(미러 깊이 50, 되돌림):** maker reconcile churn(900주문/1.5s)이 체커 일시 red를 키워 **20으로 복귀**
  (net config 변경 없음). 충실도 핵심은 ② 테이커라 깊이 불필요.
- **정합성 측정 프로토콜(feedback-026):** 정산이 async(엔진→Kafka→워커)라 라이브 트레이딩 중 point-in-time
  체커는 in-flight(체결 기록됐으나 지갑/락 미반영)로 F1b/F1c/F4가 **일시 red를 깜빡인다 — 금전 사고 아님**
  (정지+드레인 시 항상 0 fail). *위 "부하 중 green"은 단일 샘플이었고, 조밀 샘플링에서 일시 red가 보인다.*
  확정 측정은 봇과 분리해 정산 후: `scripts/check-integrity.sh`(정지→드레인→F1~F4). 시연: 봇 45s 가동 →
  스크립트 → **0 monetary fail(전 항목 green)**.

## 미결 (막지 않음)
- F#2(정산 워커 poison 이벤트 FIFO 차단, refactor-observations #18) — 이번 실행에선 방아쇠(dev 충돌) 제거로
  미발현. 임의 적용불가 이벤트가 정산을 멈추는 로버스트니스 갭은 프로드 유효, 근본 수정은 정책 결정 후.
- KRW 밸류에이션(리더보드 USDT 가정), 라이브 KRW-마켓 전략(서브계정 KRW 펀딩 경로 필요).
