# bitshuriken-prod-bots

Binance/Upbit 미러링 maker/taker 봇 + 금전 정합성 체커. (시스템 개요·계약은 상위 `../CLAUDE.md`.)

## 원칙
- **봇도 유저다** (feedback-025): 거래는 일반 유저 표면(HMAC API 키)로만. 내부 우회 없음.
- **시장 조성 계정은 레이트리밋 해제**: 부팅 시 admin 표면(`X-Admin-Secret`)으로 maker/taker 계정에
  `User.rateLimitExempt=true`를 설정 (ADR-066). `ADMIN_API_SECRET` 미설정 시 면제 생략(= `RATE_LIMIT_ENABLED=false`에서만 정상).
- 심볼 발견은 exchange-info (feedback-021). 자기 배포 정의 소유, 코어 스택 밖에서 붙음 (feedback-023).

## Structure
- `src/exchange.ts` — 한 봇 아이덴티티. signup/login(JWT) → API 키 발급 → 이후 전 거래를 HMAC 서명. 공개 시세는 무인증.
- `src/feeds/` — `ccxt-feed.ts`(공유 ws 루프) + `binance.ts`/`upbit.ts`. `index.ts`가 quote로 소스 라우팅(USDT/USDC→Binance, KRW→Upbit).
- `src/bots/{maker,taker}.ts` — feed-agnostic. 호가 미러링 / 체결 리플레이.
- `src/krw-ticks.ts` — Upbit KRW 계단식 호가단위. **BE `libs/shared/src/constants/krw-tick.ts`와 동기 유지.**
- `src/integrity/` — 금전 불변식 체커. Postgres 직접 read(무해 — feedback-025는 거래만 유저 표면 강제). F1~F4 정의는 README.
- `src/run.ts` — 오케스트레이터. `src/scan.ts` — 기회 스캐너(관찰 전용).

## 정합성 fail 기준 (유저 확정)
"다른 거래소라면 일어나지 않았어야 하는 금전적인 일" — F1 장부 대사 / F2 청산 미발생·오발생 / F3 PnL·원장 / F4 frozen 미해제. 패리티(미러 이탈)는 warn.

## Run / test
```bash
npm run bots            # 미러링 시작
npm run check[:watch]   # 정합성 (exit 1 on 금전 fail)
npm run scan            # 기회 관찰
npm run typecheck       # tsc --noEmit
```
KRW 마켓은 base 자산 + KRW quote + Upbit 계단식 tick. 소스(Binance/Upbit)는 quote 자산으로 결정된다.
