# Handoff 2026-08-19 — 미러 봇 "제대로" 목표 (리서치→구현→적대검증 사이클)

**목표(유저)**: Binance/Upbit 시장을 그대로 가져와 조성하는 봇을 제대로 만들 때까지. 리서치→구현→적대적 검증 순환. 거래소 제한·오더북 재현 문제는 유저에게 질문.

## 사이클 상태
- **리서치 1회차 ✅** — 문서 스윕 + 코드 감사 완료. 핵심: 07-12 충실도 수치(p99 0.22bps)는 depth50/rec150/TPS20 기준인데 07-14에 depth10/rec600/TPS5로 디튠된 채 방치, 디튠 원인(Wallet 락)은 ADR-069 S2로 이미 소멸. 테이커가 소스 체결가를 버려 꼬리/캔들 미충실. 2계정 구조가 지연 왜곡(유저 지적).
- **구현 1회차 ✅** — 아래 변경 전부 bots 레포 워킹트리 (미커밋), `npm run typecheck` green.
- **적대적 검증 1회차 ⏸ 중단** (토큰 절약, 유저 지시). 리뷰 결과 미수령 — 아래 "다음 세션" 참조.

## 유저 확정 (ADR-070 에 기록됨)
① 테이커 = **소스 가격 캡 LIMIT IOC** ② 선물 = **스팟 동반 심볼만** (executedQty=0 재검증 선행) ③ 과부하 시 **depth50 고수, 심볼 축소** ④ **MM 계정 심볼당 분리 + 정밀도 테스트 먼저** (유저 추가 지시).

## 구현 내역 (bitshuriken-prod-bots, 전부 미커밋)
- `src/precision.ts` — floorPrice/ceilPrice/snapPrice 신설 (메이커 bid=floor/ask=ceil, 테이커 캡은 반대방향).
- `src/bots/maker.ts` — 사이드 인지 스냅; FOREIGN 장애물 시 사이드 통째 홀드 → **장애물 안쪽 클램프 미러**; warnOnce 인스턴스화+60s 재로그(계통 장애 은폐 제거); passOpsCap 설정화(`MAKER_PASS_OPS_CAP`).
- `src/bots/taker.ts` — 재작성: 사이드별 소스가 워터마크(sweepBuy/sweepSell), 캡=max(워터마크,터치), 캡 안 다레벨이면 takeable 전량 스윕, dust 규칙 유지, ApiError 스로틀 로그.
- `src/feeds/ccxt-feed.ts` — 첫 배치 삼킴 프라이밍(WS 과거체결 폭주 제거), (ts, ids-at-ts) 커서(동일ms 체결 유실 제거), BadSymbol 영구 제외.
- `src/feeds/upbit.ts` — ping keepalive 30s, waiter 코드당 1개(누수 제거).
- `src/run.ts` — 재작성: **(role,market,symbol)당 계정** (`maker-btcusdt@bots.local`, 선물 `-f-`), 멱등 펀딩(target/2 미만만 충전)+10분 리필 루프, API 키 `.bot-keys.json` 영속(무한 발급 제거), 선물 계정 USDT→FUTURES 이체 부족분만, setLeverage 실패 로그.
- `src/bench.ts` **신설** — `npm run bench -- --minutes 5 --out x.json`: top-of-book |mid편차| median/p95/p99/max(bps, 소스는 venue당 배치 1콜) + 완결 1분봉 H/L/C·볼륨 대조. **충실도 주장의 정본 도구.**
- `src/fidelity.ts` — watch 모드 stale mid 버그 수정. `.env` — depth50/rec150/TPS20, SPOT 9+KRW 5종, FUTURES BTC/ETH. `config.ts` passOpsCap. README/CLAUDE.md 갱신. `docs/adr/070-mirror-fidelity-restoration.md` 신설.

## 스택 상태 (세션 종료 시점)
`exchange.sh reset` 완료(DB 초기화·토픽 P=6) 후 **`exchange.sh start` 실패**: be-spot까지 OK,
**be-futures가 부팅 크래시** — `LedgerBootstrap → LedgerBaseliner.baseline`에서 Prisma P2028
(interactive tx 5000ms 타임아웃, 5420ms 소요; BalanceJournal). ADR-069 S2 원장 부트스트랩의
BE측 기존 코드 이슈(봇 변경과 무관), 리셋 직후 콜드 부팅에서 발생. **재개 첫 액션**: start 재실행
(재발 시 baseline tx 타임아웃 상향 — be `ledger` 모듈의 baseline $transaction 옵션). 로그:
`logs/be-futures.log`.

## 다음 세션 (적대검증 1회차 재개 절차)
1. **적대적 코드 리뷰 재실행** (결과 미수령 상태로 중단). 공격 포인트: KRW tier 경계에서 floor/ceil이 타 tier 틱 생성? / maker 클램프가 장애물 중 사이드를 얇게 만드는지 / 테이커 워터마크 staleness(take 연속 실패 시 오버스윕) / 피드 WS 재접속 후 커서 의미 / ensureFunded FUTURES 시퀀스·USDTKRW base 펀딩 100k USDT가 Upbit 30레벨에 충분한지 / **BE GET 부하 산술: maker 터치폴 16심볼×6.7/s≈107 + taker 폴 64/s + TPS20×16 주문 상한 vs S2 유효 100~120 TPS** → 공유 터치 캐시/폴 완화 필요할 수 있음.
2. `npm run bots` → 워밍업(수 분) → **`npm run bench -- --minutes 10 --out bench-1.json`** (유저 지시: 정밀도부터). 과부하(정산 랙·p95 폭증·CPU 200%+) 시 ADR-070대로 **심볼 축소**(잔존: BTC/ETH+KRW).
3. 선물: BTCUSDT/ETHUSDT perp 체결이 실제 발생·정산되는지 (ADR-037 executedQty=0 재검증). 실패 시 FUTURES_SYMBOLS 비우고 유저 보고.
4. 미러 정지(`pkill -INT -f src/run.ts`) → PENDING=0 → `./scripts/check-integrity.sh` (F1~F4 0 fail 필수).
5. 결과로 test-report + journal/lessons 갱신, 사이클 반복 (리서치 2회차 = bench 결과 기반 갭 분석).

주의: 재기동 하드룰(핸드오프 07-14-2) 유지 — 미러 정지+PENDING=0 창에서만 BE 재기동.
