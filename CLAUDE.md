# bitshuriken-prod-bots

Binance/Upbit 미러링 maker/taker 봇 + 금전 정합성 체커. (시스템 개요·계약은 상위 `../CLAUDE.md`.)

## 원칙
- **봇도 유저다** (feedback-025): 거래는 일반 유저 표면(HMAC API 키)로만. 내부 우회 없음.
- **시장 조성 계정은 레이트리밋 해제**: 부팅 시 admin 표면(`X-Admin-Secret`)으로 maker/taker 계정에
  `User.rateLimitExempt=true`를 설정 (ADR-066). `ADMIN_API_SECRET` 미설정 시 면제 생략(= `RATE_LIMIT_ENABLED=false`에서만 정상).
- 심볼 발견은 exchange-info (feedback-021). 자기 배포 정의 소유, 코어 스택 밖에서 붙음 (feedback-023).

## Structure
- `src/exchange.ts` — 한 봇 아이덴티티. signup/login(JWT) → API 키 발급 → 이후 전 거래를 HMAC 서명. 공개 시세는 무인증.
  계정은 **(role, market, symbol)당 1개** (`maker-btcusdt@bots.local`, 선물은 `-f-` 접두, ADR-070) — 키는 `.bot-keys.json`에 영속, 펀딩은 멱등(부족분만 충전 + 주기 리필).
- `src/feeds/` — `ccxt-feed.ts`(공유 ws 루프) + `binance.ts`/`upbit.ts`. `index.ts`가 quote로 소스 라우팅(USDT/USDC→Binance, KRW→Upbit).
- `src/bots/{maker,taker}.ts` — feed-agnostic. 호가 미러링(POST_ONLY 증분, feedback-027) / 체결 리플레이(소스 가격 캡 LIMIT IOC — 소스 스윕 가격까지만 스윕, ADR-070).
- `src/krw-ticks.ts` — Upbit KRW 계단식 호가단위. **BE `libs/shared/src/constants/krw-tick.ts`와 동기 유지.**
- `src/integrity/` — 금전 불변식 체커. Postgres 직접 read(무해 — feedback-025는 거래만 유저 표면 강제). F1~F4 정의는 README.
- `src/run.ts` — 오케스트레이터. `src/scan.ts` — 기회 스캐너(관찰 전용).

## 정합성 fail 기준 (유저 확정)
"다른 거래소라면 일어나지 않았어야 하는 금전적인 일" — F1 장부 대사 / F2 청산 미발생·오발생 / F3 PnL·원장 / F4 frozen 미해제. 패리티(미러 이탈)는 warn.

**측정은 정산 드레인 후 (봇과 분리, docs/feedback/026):** 정산은 async(엔진→Kafka→워커)라 라이브 트레이딩 중에는 "체결 기록됐지만 지갑/락 미반영" in-flight로 F1b/F1c/F4가 일시 red를 깜빡인다(금전 사고 아님 — 정지 시 항상 0 fail). 봇을 충분히 돌린 뒤 주문 흐름을 멈추고 측정한다: `../scripts/check-integrity.sh`(정지→드레인→F1~F4). 라이브 중 red는 재확인 시 잔존해야 진짜 fail.

## Run / test
```bash
npm run bots            # 미러링 시작
npm run check[:watch]   # 정합성 (exit 1 on 금전 fail)
npm run bench           # 미러 정밀도 벤치 (top-of-book percentile + 1분봉 대조; 충실도 주장의 정본)
npm run scan            # 기회 관찰
npm run typecheck       # tsc --noEmit
```
KRW 마켓은 base 자산 + KRW quote + Upbit 계단식 tick. 소스(Binance/Upbit)는 quote 자산으로 결정된다.
