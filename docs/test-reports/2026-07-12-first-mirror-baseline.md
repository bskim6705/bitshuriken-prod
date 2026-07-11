# 첫 미러링 실행 + 금전 정합성 기준선 (2026-07-12)

프로드 포크 이후 첫 라이브 실행. `bitshuriken-prod-bots`를 로컬 스택에 붙여 Binance/Upbit을
미러링하고 `npm run check`(F1~F4)로 금전 불변식을 측정했다. **판정: 아키텍처 end-to-end 입증 +
정합성 하네스가 실제 결함 2건을 잡아냄** (goal #1의 목적대로).

## 실행 구성
- 스택: BE spot/futures/portal + 매칭엔진(당시 단일 인스턴스, `tickers.json` 합본) + Postgres/Kafka.
- 봇: maker/taker 2계정, HMAC API 키, `SPOT_SYMBOLS=BTCUSDT,ETHUSDT,BTCKRW,ETHKRW,USDTKRW`, futures 없음.

## 작동 확인 (end-to-end)
- ✅ 봇 부팅: signup → HMAC 키 발급 → **rateLimitExempt 플래그 설정(ADR-066 admin 엔드포인트)** → 펀딩(KRW 포함).
- ✅ **USDTKRW 완전한 양방향 책** (top bid 1490 / ask 1495 — 둘 다 [1000,10000) tier의 tick 5 정렬 정확),
  BTCKRW 매도호가(95,879,000 = tick 1000 정렬). → 피드→maker→**HMAC 주문→계단식 tick 검증→엔진→BE 캐시** 전 경로 동작.
- ✅ Upbit REST/스냅샷 데이터 유입. Binance REST 200 도달.

## F1~F4 측정 결과 (check @ 03:40)
| 항목 | 결과 |
| --- | --- |
| F1a 음수 잔고 없음 | ✅ PASS |
| F1b spot 지갑 = funding+체결 원장 | ✗ 시드 유저(alice/bob) 8건 — 시드가 지갑 직접 크레딧(원장 우회). **봇 계정은 통과** |
| F1c executedQty = Σ체결 | ✗ 138건 exec=0인데 체결 존재 — 아래 F#2(정산 워커 잼)의 증상 |
| F4 spot locked = Σ오픈잠금 | ✗ 3건(라이브 처칭 중 in-flight + 아래 잼) |
| F3a/b/c 선물 원장·zero-sum·Σqty=0 | ✅ PASS |
| F2 청산 오라클 | ✅ PASS (포지션 없음) |
| PARITY | ETHUSDT F 4.9bps 등 — 정보성(warn) |

## 발견 결함

### F#1 (dev 하네스) — 크로스마켓 심볼 충돌로 spot 주문이 futures에서 체결
`up.sh`가 매칭엔진을 **단일 인스턴스 + 합본 `tickers.json`**(spot 55 + futures 47, BTCUSDT/ETHUSDT가
양 마켓 중복)으로 기동. 엔진 `LaneRegistry`는 **심볼만**으로 lane을 키잉하므로 spot·futures BTCUSDT가
충돌 → 봇이 `match.spot.in`에 보낸 주문이 futures lane에서 체결돼 `match.futures.out`으로 나가고
be-futures가 futures 체결(BTCUSDT 23 / ETHUSDT 107)을 생성. **프로드는 두 인스턴스(tickers-spot/
futures.json 분리)라 무해 — dev 전용.**
- **수정(2026-07-12):** `up.sh`가 프로드처럼 `match-spot`(tickers-spot.json)/`match-futures`
  (tickers-futures.json) 두 인스턴스를 기동하도록 변경.

### F#2 (프로드에도 유효) — 적용 불가 정산 이벤트 하나가 FIFO 드레인을 영구 차단
`FuturesSettlementWorker`가 이벤트 하나에서 `futures USDT wallet not found for user …`로 throw →
FIFO 순서상 뒤 130건이 전부 PENDING 고착, 재시도 무한 반복(정산 파이프라인 정지). poison 이벤트를
격리/스킵/DLQ하지 않고 순서대로 막힘. F#1이 만든 "지갑 없는 유저의 futures 체결"이 방아쇠였으나,
**임의의 적용 불가 이벤트가 전체 정산을 멈출 수 있다는 로버스트니스 갭**은 프로드에서도 위험.
→ `docs/specs/refactor-observations.md` #18로 기록. (spot 워커도 동형일 가능성 검토 필요.)

### F#3 (관찰) — 시드가 지갑을 원장 없이 직접 크레딧
`prisma db seed`가 alice/bob 지갑을 `wallet.create`로 직접 크레딧 → F1b가 "원장 없는 잔고"로 정확히
탐지. 실거래소는 모든 크레딧에 원장이 있어야 함. 시드가 FundingTx(ADJUSTMENT) 행도 쓰거나, 체커가
시드 계정을 명시 제외하는 게 맞음. 봇/유저 계정은 deposit→FundingTx라 정상.

## 판정 & 다음
- **아키텍처·핵심 경로는 검증됨**(특히 KRW 계단식 tick + HMAC + 면제 + 정산까지 USDTKRW로 완주).
- **정합성 하네스가 제 역할을 했다** — 부하 하에서 dev 토폴로지 버그 + 정산 로버스트니스 갭을 자동 검출.
- **녹색 기준선**은 DB 리셋(오염 제거) + 수정된 2-인스턴스 토폴로지 재기동 후 재측정 필요 — 리셋은 유저 결정
  (`prisma migrate reset` 계열은 유저만). 재측정 시 KRW-only 심볼 세트(충돌 없음)로 spot 보존 확인 → futures 추가.
- check.ts: parity fail이 exit code를 오염시키던 버그 수정(금전 fail만 게이트).
