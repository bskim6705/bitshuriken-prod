# 미러링·정합성·수익전략 테스트 플랜 (2026-07-11)

> 목적 (유저 확정): ① 이 거래소가 **실제 시장과 비슷하게 운영 가능한지**, ② 이 프로젝트로 **수익 내는 전략을
> 테스트 가능한지**를 검증한다. Binance·Upbit을 그대로 미러링하면서 아비트라지 등 트레이딩 기회를 관찰한다.
> 선행 조건이던 오픈버그 2건(OCO 취소 레이스, trigger dead path)은 2026-07-11 수정 완료
> (refactor-observations #2/#3).

## 0. 확정 정책 (유저 결정 2026-07-11 — feedback-016)

- **봇도 유저다** (feedback-025): 거래는 일반 유저 표면(HMAC API 키·서브계정)로만. 내부 우회 금지.
- **시장 조성 계정은 레이트리밋 해제**, 즉 일반 계정에는 레이트리밋이 걸린 상태가 목표
  (= `RATE_LIMIT_ENABLED` 활성 전환 포함).
- **Binance + Upbit 실시간 미러링**. Upbit을 위해 **KRW quote 자산 추가** (코어는 quote-agnostic — ADR-008).
- **정합성 fail 정의 = 금전적 불변식 위반** ("다른 거래소라면 일어나지 않았어야 하는 금전적인 일"):
  - **F1 장부 대사 불일치** — 지갑 잔고 변화 ≠ 원장(SettlementEvent/FundingTx/FuturesIncome) 합계
  - **F2 청산 오동작** — 났어야 하는데 안 남 / 나면 안 되는데 남 (양방향)
  - **F3 PnL 오계산** — RPNL/수수료/펀딩 재계산 불일치, zero-sum 위반
  - **F4 frozen 미해제** — 터미널 주문·리스트의 잔여 잠금, locked ≠ Σ오픈 잠금
  - 비금전 지표(미러 패리티 이탈 등)는 fail이 아닌 **warn** 등급.

## 1. 출발점 (2026-07-11 현재 상태 평가 요약)

- 외부 봇 API 표면 완비: HMAC 키+스코프, 공개 시세 REST/WS, 유저 데이터 스트림, clientOrderId.
  레이트리밋은 구현돼 있으나 기본 OFF (`RATE_LIMIT_ENABLED=false`).
- v2 아카이브 자산: `bitshuriken-v2-bots`(ccxt.pro Binance 미러링 MakerBot/TakerBot + DB invariant 체커,
  ADR-037), `bitshuriken-v2-agents`(전략=서브계정, SimBroker 백테스트/LiveBroker). Upbit 코드는 전무 — 신규.
- BE `test/integrity/` 라이브 하네스는 dex/options 잔재로 스테일 — 정리 후 사용.
- 남은 알려진 리스크: 보험기금 원장 검증 미실시(ADR-065), ADR-064 런타임 e2e 미검증, "선물 마켓주문
  executedQty=0"(ADR-037 관찰) 재검증 필요, STP 부재(웟시 자유 — 의도된 경계), 엔진 독성 메시지 크래시 루프,
  관찰 #17(단일 stop 취소 앞지름 — 스키마 변경 필요라 보류).

## 2. Phase 0 — 기준선 (진행 상황 2026-07-12)

1. ✅ BE 미커밋 2묶음(계정 보안 / 거래 보호) + 버그 수정 #2/#3 커밋
2. ✅ `prisma migrate dev --name account-security` (유저 실행) + 마이그레이션 커밋
3. ✅ e2e 53/53 통과 (Kafka 기동 후). 유닛 295/295.
4. ✅ `test/integrity` dex/options 제거, run-all/README를 prod 3앱 기준으로 정리
5. ⏳ 라이브 정합성 1회 실행 → **기준선 리포트** `docs/test-reports/` (봇 기동 후 — Phase 2 이후)

**구현 완료(2026-07-12), 실행만 남음:**
- `bitshuriken-prod-bots` — Binance/Upbit 미러링 봇 + F1~F4 체커 + scan (typecheck 클린, ADR-066)
- `bitshuriken-prod-agents` — 전략 러너(서브계정+HMAC, Sim/Live 브로커, 시드 전략) (typecheck 클린)
- BE — KRW 계단식 tick 검증 + exchange-info priceTiers + `User.rateLimitExempt` 플래그 + admin 면제 엔드포인트
- KRW 자산/티커 시드 (USDTKRW/BTCKRW/ETHKRW/XRPKRW/SOLKRW), 매칭엔진 config 추가

**⏸ 실행 전 유저 액션 1건: 2차 마이그레이션** (`User.rateLimitExempt` + `AssetType.FIAT`) —
`cd bitshuriken-prod-be && npx prisma migrate dev --name rate-limit-exempt-krw` → 이후 `npx prisma db seed`.

## 3. Phase 1 — 정합성 측정기 v1 (F1~F4)

- **F1**: 계정×자산별 대사 — Δ지갑 == Σ SettlementEvent legs + Σ FundingTx + Σ FuturesIncome.
  v2 bots의 INV-1~4 SQL 이식(스키마 diff 확인) + 대사 쿼리 신규. 보험기금도 동일 대사:
  fund 지갑 Δ == Σ(LIQUIDATION_FEE + INSURANCE_CLEAR + 펀딩 dust).
- **F4**: spot `Wallet.locked` == Σ(오픈 주문 잔여 잠금) + Σ(EXECUTING OCO lockAmount);
  futures 동형(lockedCost); 터미널 주문/리스트 잔여 잠금 0.
- **F3**: fill 시퀀스 리플레이로 RPNL/수수료 재계산 ↔ FuturesIncome 대조; 펀딩 zero-sum;
  `sum(Position.qty) == 0` per symbol.
- **F2 청산 oracle**: mark 시계열 기록(신규 — 1s 틱 로그) → 오프라인 판정 "marginRatio ≥ 1 지속 →
  청산 발생했어야" ↔ 실제 LIQUIDATING/LIQUIDATION_TAKEOVER 대조. 오발생 방향도 검사.
- 형태: one-shot(fail → exit 1, CI 사용 가능) + `--watch` 상시 모드. 위반 시 fail 로그 + 리포트 파일.
- 실행 위치: 이식된 봇 레포의 `npm run check` 확장이 기본안 (DB 읽기 전용은 feedback-025 위반 아님).

## 4. Phase 2 — Binance 미러링 이식 (spot 먼저)

- `bitshuriken-v2-bots` → **`bitshuriken-prod-bots`** 신규 레포 (자기 배포 소유 — feedback-023,
  `bitshuriken_internal`에 external로 attach).
- 인증 전환: 세션 JWT → **HMAC API 키** (feedback-025). maker/taker는 각각 독립 유저 유지(STP 부재 대응).
  펀딩은 dev 민트(`POST /account/deposits`) — prod 배포에선 admin 조정으로.
- **레이트리밋 활성화**: `RATE_LIMIT_ENABLED=true` + MM 계정 면제. 메커니즘 선택 필요(§7-1).
- 미러링 부하에서 Phase 1 체커 상시 실행. spot 검증 후: "perp 마켓주문 executedQty=0" 재검증 →
  통과 시 futures 미러링 개시 (mark price가 spot 체결 EMA에서 살아나 청산·펀딩 경로가 처음으로 실구동).

## 5. Phase 3 — KRW quote + Upbit 미러링

- **KRW Asset 추가**. 코어는 quote-agnostic (Asset 1급, Ticker base/quote FK, Wallet 자산별)이나
  확인·결정 지점:
  - precision: BTC/KRW 가격 ~1.6억 → pricePrecision 0 (0+8 ≤ 8 제약 통과). KRW Asset.precision=0.
  - **Upbit 호가단위는 가격대별 계단식** — 고정 tickSize 모델과 불일치. 재현 수준 결정 필요(§7-3).
  - 리더보드/net-worth가 USDT 가정(ADR-045/047) — KRW 지갑 밸류에이션 미결(§7-4). 1단계는 왜곡 감수 명시.
- **UpbitFeed 신규**: ccxt upbit (ccxt.pro WS 지원 범위 확인 — 미지원이면 Upbit 공식 WS 직결).
  MakerBot/TakerBot은 feed-agnostic이라 재사용. KRW 심볼 상장(예: BTCKRW)은 admin ticker API로.

## 6. Phase 4 — 기회 관찰 + 수익 전략

- **기회 스캐너** (관찰 전용, 주문 없음): BTCUSDT(바이낸스 미러) ↔ BTCKRW(업비트 미러) 환산 스프레드 =
  김치프리미엄 재현 검증; 삼각 차익; 현물–선물 베이시스+펀딩 캐리; 스테일 호가 차익. 시계열 기록 → 리포트.
- **전략 실행기**: `bitshuriken-v2-agents` 이식 (전략 1개=서브계정 1개, HMAC — feedback-025와 정합).
  시드 전략: 김프 아비트라지(양 마켓 동시 체결 — **환전 마켓 없으면 재고 누적 문제**, §7-2), 베이시스/펀딩
  캐리, 기존 grid/momentum.
- 성과 측정: 리더보드(ROI) + 원장 + agents 원장 리플레이 대사. 구조 특성 명시: 차익 전략의 이익은
  미러링 봇(유동성 공급자)의 손실 — 실제 시장의 차익거래와 동형이며, MM 계정 잔고는 소모품으로 운영.

## 7. 유저 결정 — 확정분 (2026-07-12) / 잔여

**확정:**
1. **MM 레이트리밋 면제 = 계정 단위 플래그** (옵션 A). 구현 시 User(또는 ApiKey) 스키마 필드 추가 —
   Prisma 마이그레이션 동반, Phase 2에서 진행.
2. **USDT/KRW 환전 마켓 상장 확정** — Upbit의 USDT/KRW 마켓을 미러링 대상에 포함(심볼 `USDTKRW`,
   base USDT / quote KRW). 김프 차익 실현 경로가 생기고, 스테이블코인 김프 자체도 재현된다.
3. **Upbit 호가단위는 계단식 그대로 재현** — 고정 tickSize 근사가 아니라 가격대별 호가단위 함수를 구현.
   현행 모델(Ticker.pricePrecision → 고정 tick)과 불일치하므로 tick 검증을 가격 의존 함수로 확장
   (BE order-validation + exchange-info 표현 + FE 주문폼). 엔진은 tick을 강제하지 않으므로(BE 소관) 엔진 변경 없음.
   설계는 ADR-066+에서 확정.

**잔여 (막지 않음 — 해당 Phase 도달 시 확인):**
4. **KRW 밸류에이션** — 리더보드·순자산에서 KRW 지갑 평가 방법 (후속 ADR 후보). 1단계는 왜곡 감수 명시.
5. **신규 레포 이름** — `bitshuriken-prod-bots` 제안대로 진행 예정, 이견 있으면 그때 변경.

구현 착수 시 봇 아키텍처·KRW/호가단위 설계는 **ADR-066+**로 기록한다.

## 8. 성공 기준

- **운영 가능성**: 미러 패리티 mid 수 bps 유지, 24h 지표·펀딩·청산이 실데이터 리듬으로 발생,
  F1~F4 fail 0건 N일 연속 (N은 기준선 이후 합의).
- **전략 테스트 가능성**: 서브계정 전략 1개 이상이 라이브 수익 곡선 생성, 백테스트와 방향 일치,
  회계 대사(원장 리플레이) 통과.
