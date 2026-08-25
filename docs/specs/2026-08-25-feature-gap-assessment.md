# 2026-08-25 — 기능 격차 평가 (단일 프로세스 토폴로지 기준)

> 질문: "단일 스레드 기준으로 돌아가서, 기능을 더 좋게 할 것들." 판단 기준: 실거래소(Binance) 기준(feedback-024) × 이 거래소의 목적(스캘핑·HFT 전략 실효성 테스트 + 미러링 + 정합성).
> 방법: ① Binance 대비 기능 매트릭스 전수 조사(BE+엔진), ② docs·전략 런 기록·bots/agents 코드의 기록된 페인포인트 발굴.
> 수평 확장 관련은 별도: docs/specs/2026-08-25-horizontal-scale-audit.md.

## 먼저: 이미 잘 되어 있는 것 (재확인)
TIF 3종(GTC/IOC/FOK, 엔진측 집행) · POST_ONLY(reject-on-cross) · 스팟 스탑 4종+OCO · 선물 7타입+reduceOnly · isolated+cross 마진(진짜 구현) · 펀딩(Binance형 공식+클램프) · 가격밴드(스팟±10%/선물 mark 기준) · KRW 계단 틱 · 레이트리밋 헤더+가중치 · kline 16개 인터벌 · aggTrade/bookTicker/miniTicker/markPrice 스트림 · listenKey 유저 스트림 · 서브계정·이체·API키 스코프. 골격은 실거래소급.

---

## A. 목적(HFT·스캘핑 테스트)에 직결되는 격차 — 최우선 후보

### A1. 수수료 티어 / 메이커 리베이트 — 목적을 막고 있는 단일 최대 구조물 [정책]
- 현재: 유저당 플랫 maker/taker 10bps (`User.feeMakerBps/feeTakerBps`, admin 수동 변경만). VIP 티어·볼륨 집계·리베이트 없음 (ADR-025).
- 기록된 증거: lessons **L1** "테이커 왕복 20bps는 스캘핑의 벽 — 신호 이전에 수수료로 진다 (07-12 스캘핑 6종 전패)", **L6** "김프 삼각 arb는 테이커 3레그 30bps 구조에서 무발화 — 재설계 조건: 메이커화 or 수수료 티어".
- 실거래소: Binance VIP 0~9 (30d 볼륨), 상위 티어 메이커 0.0~1.2bps. HFT/MM의 손익 구조 자체가 티어 위에 서 있다.
- 필요 결정: 티어 테이블(30d 볼륨 기반 자동?) vs 단순 설정형 리베이트. 정산 경로는 이미 유저별 bps를 읽으므로 구현 지점은 명확.

### A2. 주문 amend(modify) — 엔진 신규 op [엔진+BE]
- 현재: 취소+재접수뿐. 스팟 cancel-replace도 **비원자**(새 주문 먼저 → 취소 실패 시 주문·락 2중, 관찰 #12). 선물엔 그마저 없음.
- 워크어라운드 실증: 미러 메이커가 in-flight replacement 겹침용 예산을 따로 잡고(`maker.ts:78-79`), self-cross 방지 위해 전 취소 직렬화 후 배치(`:220-222`).
- 실거래소: Binance 선물 order modify(가격/수량, 우선순위 규칙 포함). HFT 호가 갱신의 표준 경로.
- 엔진 작업: 새 op `AM` + `OrderBook.amend`(가격 변경=재큐잉, 감량=우선순위 보존). 엔진 인바운드는 현재 NO/CO 2종뿐이라 침습 범위가 명확.

### A3. STP(자전거래 방지) — 가장 싼 고가치 엔진 추가 [엔진, 정책]
- 현재: matcher가 maker/taker user_id를 비교하지 않음 — 자전 체결이 정상 체결로 성사되고 양측 수수료 부과(ADR-025 "의도된 동작"). 봇=유저 환경이라 비가설적.
- `user_id`는 이미 양측 Order에 실려 있어 matcher 비교 + NewOrderMsg에 stp 모드 1필드 + 신규 종료 사유면 됨. 07-22 감사 F①이 EXPIRE_TAKER 권장으로 정책 대기 중.

### A4. 체결을 밀어주는 경로 — "주문 응답 executedQty=0" 문제 [BE 정책 + 클라이언트]
- 현재: 정산 async라 주문 응답에 체결이 안 담김. 실증 사고: 체결을 미체결로 오판 → 매 틱 재매수 → 의도 500 USDT의 13배 폭주(07-12). 이후 "체결은 잔고/체결내역에서 확인" 규칙으로 봉합.
- 그런데 **listenKey+executionReport가 이미 존재하는데 bots/agents 어디서도 소비하지 않는다**(레포 전체 0건). 대신 maker 5s resync 폴 + live.ts 트레이드 페이지 폴(포화 시 체결 유실 자인 주석) — 핸드오프 실측 ~170 GET/s가 S2 유효 100~120 TPS 예산을 잠식.
- 두 갈래: ① (클라이언트) bots/agents가 유저 스트림 소비 — 거래소 코드 무변경, 즉효. ② (거래소) 응답 시맨틱 개선 — Binance는 MARKET FULL 응답에 fills 동봉. 07-22 감사 F④(reserve-then-respond/outbox) 정책 대기.

### A5. 오더북 diff 스트림 + 속도 티어 [BE]
- 현재: 엔진은 seq 붙은 DPD diff를 이미 내는데, BE가 캐시에 흡수 후 **1초 고정 스로틀로 50레벨 전체 스냅샷 재전송**. `@depth@100ms`·U/u/pu diff 엔벨로프·depth5/10/20 부분북 전부 부재.
- HFT 전략의 표준은 diff로 로컬 북 유지. 미러 봇의 터치 폴(107/s)도 이걸로 대체 가능.
- 동반 필수: **WS 백프레셔 부재(H3** — `bufferedAmount` 체크 0곳, 느린 클라이언트가 프로세스 메모리를 무한 흡수) 같이 해결. 엔진측은 pu(직전 최종 update id) 1필드 추가면 족함.

### A6. kline 영속화 [BE, 성능+보안 겸]
- 현재: 캔들 저장 0 — 매 요청·매 WS 구독자·매 1초마다 Trade 테이블 raw SQL 재집계(`(array_agg ORDER BY seq))[1]` 패턴). 07-22 감사 H2: "인증만 있으면 유저 도달 가능한 DB DoS".
- 1m 캔들 테이블(정산 경로에서 증분 갱신) + 상위 인터벌 파생 + `startTime` 파라미터(현재 endTime뿐)가 실거래소 표준.

---

## B. 선물 리얼리즘 — 실거래소 기준 격차

| 항목 | 현재 | 실거래소 | 비고 |
|---|---|---|---|
| **티어드 MMR(레버리지 브래킷)** | 심볼당 플랫 mmr 1개, `/leverage-bracket`이 항상 1브래킷 반환 | 노셔널 구간별 MMR·최대 레버리지 | 청산 수학 교체 지점: `margin-math.ts:65,105`, `liquidation-executor.ts:62-72` [정책] |
| **부분청산** | 전량 IOC MARKET 단일 경로 | 브래킷 하향 부분청산 먼저 | A9(캐스케이드 시 처리량→0)와 같이 설계 [정책] |
| **ADL** | 부재 — 파산 잔여는 보험기금 인수뿐 | 보험기금 소진 시 반대 포지션 자동 감축 | 북 우회 직접 포지션 이전(SettlementEvent)으로 BE만으로 가능 [정책] |
| **포지션 부착 TP/SL** | 독립 스탑 주문뿐, reduceOnly 용량 규칙 탓에 TP·SL 동시 전량 불가(FE가 1건씩 접수 중) | closePosition:true 스탑, 포지션 브래킷 | FE 페인포인트 실재 |
| **트레일링 스탑** | 스팟·선물 모두 부재 | TRAILING_STOP_MARKET (callbackRate) | BE 트리거 루프 확장만으로 가능 — 엔진 무관 |
| **workingType** | 선물 트리거가 mark 고정 | MARK/CONTRACT 선택 (기본 CONTRACT) | DTO+트리거 분기 |
| **레버리지 변경 규칙** | qty==0만 검사 — **열린 주문 있어도 허용 (A10 익스플로잇, 유저 도달 가능)** | 열린 주문 있으면 거부 | 사실상 버그, 즉시 후보 |
| **선물 전용 상장** | 불가 — 인덱스가 자기 스팟 체결 EMA뿐 (#20) | 외부 인덱스 | 이 시스템의 자연해: **미러 소스를 인덱스로 주입**(#20 옵션②) [정책] |
| **헤지 모드 / 멀티에셋 마진 / 펀딩 인터벌 4h** | 부재 / 부재 / 8h 고정 | 있음 | 우선순위 낮음 — 테스트 목적상 후순위 제안 |

## C. 전략 프레임워크(agents) — 거래소 기능을 못 쓰고 있는 쪽
거래소가 아니라 클라이언트 결함이지만, "전략 테스트 실효성"이 목적이므로 동급으로 취급해야 함:
- **`submit()`이 orderId를 안 돌려줌** → 전략이 자기 미체결 주문을 취소 못 함 → crashcatch/atrladder가 정적 사다리로 강등, **L17**: 재앵커 부재로 상승 심볼 3d 백테 0체결(멀티데이 백테 구조적 무효).
- **OrderIntent에 STOP/OCO/POST_ONLY/reduceOnly 없음** — BE가 7타입+OCO를 제공하는데 전략은 전부 클라이언트측 TP/SL 재구현.
- **ExecutionContext가 bar만 제공, 오더북 미노출·단일 심볼** — 오더북/삼각 arb 전략이 프레임워크 밖 단독 엔트리포인트로 이탈(07-12).
- **live.ts SPOT 전용** → EVO-7 숏 프로그램 NO-GO. **sim.ts가 음수 포지션 제로화 — 숏 백테 ROI 오염(+37.6% 허위), 현존 확인됨**(`sim.ts:174-177`). 후자는 버그.
- KRW 마켓 전략 경로 부재(서브계정 KRW 펀딩 루트) — 07-12부터 반복 기록.

## D. 자금이 걸린 데드패스·운영 도구 (기능 이전에 막아야 할 구멍)
1. **H1: 선물 트리거 redriveArmedNo 미이식** — armed 스탑+락 마진이 재부팅까지 고착, 크래시 직후가 최악. 스팟엔 있음(`trigger.service.ts:108`).
2. **`Order.cancelRequestedAt` 스키마 1개로 #17(CO가 발화 NO 추월)+#22+A14(중복 NO REJECTED가 살아있는 주문 클로버) 동시 해소** — 유저 결정 대기로 명시돼 있음.
3. **A15: DLQ 재적용 도구 부재** — 격리 이벤트 복구가 raw SQL뿐, 어드민 UI에도 없음. A6(포이즌 크래시루프)와 함께 settle 티어 승격 리스크.
4. **H4: 상장 3원 진실(DB/컨트롤토픽/tickers.json) 무정합 + 딜리스팅 플로우 부재** — EVO-7 실사고(엔진 config 누락 → 1,671건 NEW 고착·오프셋 통과). `scripts/list-symbol.sh` 스크립트화가 07-14부터 미결.
5. **A7: place-commit↔NO-emit 크래시 창의 고아 NEW 스윕 부재** (스탑/OCO만 redrive 있음). **A11: 펀딩 크론 경계 다운 시 무보정 스킵**.
6. **B4: pg 백업 자동화 0 (RPO=∞)** — 단일 pgdata 볼륨이 금전 진실 전부.
7. 스팟 TIF 검증 구멍(POST_ONLY+IOC 통과 — 선물은 막음), MARKET BUY base-qty 거부(Binance는 허용), EXPIRED/PENDING_CANCEL enum-문서 불일치.

## E. API 완성도 소품 (모아서 한 사이클감)
exchangeInfo `filters` 배열 부재(밴드·MAX_NUM_ORDERS가 **집행되는데 미보고** — 클라이언트가 거절 사유 발견 불가) · 히스토리 페이지네이션 `fromId`/`startTime` 부재(endTime 커서뿐) · futures `/time`·historicalTrades·REST aggTrades 부재 · open interest 부재 · 배치 주문/취소 endpoint 부재(내부 cancelAllOpen도 순차 await — H6) · `GET /rateLimit/order` 부재 · 선물 유저 스트림 이벤트명이 Binance 규격(ACCOUNT_UPDATE/ORDER_TRADE_UPDATE)과 다름.

---

## 추천 착수 구성 (유저 확정용)

| 트랙 | 내용 | 성격 |
|---|---|---|
| **① 스캘핑 실효성 팩** | A1 수수료 티어(정책) + A3 STP(정책) + A2 amend | 목적 직결, 엔진 공사 포함 |
| **② 체결 가시성 팩** | A4(bots/agents 유저스트림 소비 → 응답 시맨틱은 정책 확정 후) + A5 diff 스트림+백프레셔 + A6 kline 영속화 | HFT 데이터 경로 완성 |
| **③ 자금 데드패스 팩** | D1 redriveArmedNo + D2 cancelRequestedAt + A10 레버리지 규칙 + sim.ts 숏 버그 | 작고 급함, 대부분 결정 불요 |
| **④ 선물 리얼리즘 팩** | 브래킷 MMR→부분청산→ADL, TP/SL 부착, 트레일링 | 정책 결정 다수, 큰 공사 |
| **⑤ 운영 도구 팩** | 상장 스크립트+딜리스팅, DLQ 재적용 도구+어드민, pg 백업 | 사고 재발 방지 |

권장 순서: **③(즉시, 소형) → ①(목적 최대 레버리지) → ② → ⑤ → ④**. ①의 수수료·STP, ④ 전반, A4-②는 feedback-016에 따라 유저 정책 확정 필요.
