# bitshuriken-prod-fly

**실험 프로젝트** — FlyWire 초파리 커넥톰(FAFB v783)을 그대로 돌리는 트레이딩 뇌. agents와 별개의 폴더·의존성·
데이터를 가진다 (feedback-029: 실험은 자기 프로젝트에). TS/ESM, tsx 무빌드 실행. 시스템 개요는 상위 `../CLAUDE.md`.

## 정체성 — 봇도 유저다 (feedback-025)
거래소는 **외부에서 일반 유저로** 쓴다: 공개 시세 API + 서브계정 HMAC 주문 API. 마스터 계정(JWT)이 초파리의
서브계정을 만들고 펀딩·키 발급만 한다. BE 내부 호출·DB·Kafka 접근 없음. SPOT 롱온리.

## 뇌 (src/brain)
- **커넥톰**: FlyWire Codex 공개 버킷의 `neurons/classification/connections.csv.gz`(로그인 불필요) →
  `build.ts`가 (pre,post)별 시냅스 수를 neuropil 합산하고 Shiu 2024 부호(GABA·GLUT −, 나머지 +)를 곱해
  post-major CSR 바이너리(`data/fafb783-<region>.flybrain`)로 굽는다. `central` = 시엽·광수용체(VISUAL) 제외
  41,750 뉴런 / 1,062,130 시냅스 (`full`은 139,255 / 2.7M — 4배 느림).
- **집단**(`populations.ts`): classification의 super_class/class/sub_class → ORN·ORN_PHEROMONE·GRN·MECH_JO·
  MECH_BRISTLE·THERMO_HYGRO(감각 입력) … KC·MBON·DAN·CX … DESCENDING(1,305, 판독). 빌드가 집단 순으로
  뉴런을 재배열해 집단 = 연속 인덱스 범위.
- **동역학**(`brain.ts`): leaky-tanh rate 유닛 `h ← (1−α)h + α·tanh(gain·W h + I_in)`, bar당 4 서브스텝.
  시냅스 부호·위상 고정, 크기는 뉴런별 Lp(p=1.5) 정규화 × gain 0.9 — 실측 선택(p=1은 깊은 층 활동 소멸,
  p=2는 다중 안정 상태). 같은 입력 이력이면 초기 상태와 무관하게 float32 정밀도까지 수렴(echo state)해야
  라이브 warmup 후 상태가 학습 때와 같다 — `train`이 매번 재측정(`echoDiff`, 1e-3 초과면 경고).
- **감각 인코딩**(`features.ts`): OHLCV만으로 피처 12개(다중 지평 수익률·거래량 z·변동폭·변동성 국면·
  레인지 위치·EMA 거리, 전부 유계) → ON/OFF 정류 채널 24개 → 모달리티별 감각 뉴런에 시드 고정 희소 난수
  투사. 수익률 상승은 ORN(먹이), 하락은 페로몬 ORN(위험), 거래량·변동폭은 존스턴 기관(소리), 변동성은 온도.
- **판독**(`readout.ts`, `train.ts`): 뇌는 고정(reservoir). 하강뉴런 1,305 활동 → ridge 회귀 → 타깃
  `tanh(log(c[t+H]/c[t]) / (σ√H) / 2)`(H=15 bar). λ는 시간순 뒤 25% 검증(지평만큼 purge)의 IC로 선택.
  모델 = `data/models/<SYMBOL>-<interval>.json` (판독 벡터 + 뇌 파라미터 + 커넥톰 식별).

## 실시간 입력 + 진화 (v2 — feedback-032, ADR-078; src/lob, src/evo)
- `lob/stream.ts`: 로컬 `/ws/market` `<sym>@depth`(전체 스냅샷 push ~40/s)·`<sym>@trade`. `lob/recorder.ts`: 1초 샘플
  (top-20 양측 + 체결 + 갱신 수) → `data/lob/<SYMBOL>/<date>.jsonl` (원시 기록, 피처는 리플레이 때 재계산).
- `lob/features.ts`: 오더북 피처 27종(불균형·microprice·서명 흐름·OFI·mid 수익률·스프레드·깊이·기울기·활동·국면).
  뇌는 피처 세트 주입식(`brain/inputs.ts specsFor(inputKind)`), 감각 집단별 입력 배율은 유전자.
- `evo/genome.ts`(유전자·돌연변이) · `evo/evaluate.ts`(리플레이 평가: 앞 70% ridge, 뒤 30% 임계 정책 순수익·승률,
  테이커 수수료 `FLY_TAKER_FEE_BPS`) · `evo/evolve.ts`(엘리트 보존 + 돌연변이 + 신입, 자식 프로세스 풀) →
  최우수 파리 = `data/models/<SYMBOL>-1s.json`(inputKind 'lob', 정책 포함). `trade/lob-live.ts`가 그 모델로 실시간 거래.

## 리그 — 트레이딩 컴피티션 (feedback-031; src/league)
- `league/league.ts`: N마리 동시 라이브(슬롯마다 서브계정, 같은 자본·수수료). 시즌마다 `standings()`(시즌 순수익, 주문 수,
  승률) → 하위 relegate `retire()`(SIGTERM → 워커가 청산 후 종료) → 상위 파리 `mutate` → `fitAll`(evo 워커로 판독 재적합)
  → 새 워커 spawn. 무거래(minTrades 미만)는 최하위. 상태 `data/league/<SYMBOL>/league.json`, 슬롯 상태·모델·로그 같은 폴더.
- `league/worker.ts`: 슬롯 프로세스 = `LobLive`(model 객체·슬롯 상태 파일·status 파일). `league/server.ts`: `/api/league`,
  `/api/fly/:slot`, `web/league.html`. 수수료 티어는 올리지 않는다 — 선택 압력은 순위(강등)다.

## 거래 (src/trade)
- `policy.ts`: ŷ/yScale → 롱 노출 0..1 (yScale = 학습 구간 양의 ŷ 80분위). 목표 노출 변화가 band(0.9×maxFrac)
  미만이면 무거래, 거래 후 minHoldBars(60) 대기 → 수수료 churn 억제 (기본값은 실측 — band 0.25/hold 3은 7일에
  1,196 체결로 수수료만 −20%p). 시장가만 (MARKET_QUOTE 매수 / MARKET 매도).
- `trader.ts`: 뇌+인코더+판독+정책 한 객체. 라이브·백테스트가 같은 코드를 쓴다. WARMUP 300 bar(피처 100 +
  뇌 200)는 관찰만.
- `backtest.ts`: Binance 이력(ccxt) 재생, 종가 결정 → 다음 시가 ±slippage 테이커 체결, buy&hold 대비 ROI.
- `live.ts`: 로컬 klines 폴링(`BAR_POLL_MS`) → 새 완결 bar마다 잔고 재동기(잔고가 진실) → 뇌 → 정책 → 주문.
  warmup은 Binance 이력(미러 원천)으로 — 로컬 klines는 스택 기동 이후분만 있다. 상태(서브계정 키·기록)는
  `data/live/<SYMBOL>.json`. 대시보드 `:FLY_PORT`(5130) — `GET /api/state` + `web/`.

```bash
npm install && cp .env.example .env
npm run fly build                            # FlyWire 다운로드(~53MB, 최초 1회) + 커넥톰 빌드 (~10s)
npm run fly train BTCUSDT 1m 30 test=7       # 23일 학습 + 마지막 7일 out-of-sample 백테스트 (~12분, 18ms/bar)
npm run fly backtest BTCUSDT 1m 7            # 저장된 모델로 백테스트
npm run fly record BTCUSDT                   # 실시간 호가창 기록 (라이브와 별 프로세스로 계속) → data/lob/
npm run fly evolve BTCUSDT gens=8 pop=16     # 기록 위에서 파리 진화 → data/models/BTCUSDT-1s.json (기록 ≥ 1h 권장)
npm run fly live BTCUSDT                     # lob 모델 있으면 실시간, 없으면 bar 모드 (스택 + BTCUSDT 미러 필요) → :5130
npm run fly league BTCUSDT flies=8 season=30 relegate=3   # 트레이딩 컴피티션 (record가 돌고 있어야 함) → :5130 순위표
npm run fly flatten BTCUSDT                  # 포지션 전량 매도
npm run fly info                             # 커넥톰·모델 목록
npm run typecheck
```

## 배포 / FE
- `Dockerfile` + `docker-compose.yml`(recorder + league, `bitshuriken_internal` external 부착, `fly-data` 볼륨, `${FLY_BIND}:5130`).
  entrypoint가 커넥톰 없으면 빌드. 리소스: 파리 1 ≈ CPU 6~7%·55MB, 8마리 ≈ 0.5코어·450MB (M1 부하 실측).
- `deploy/ubuntu-macmini.sh <SPOT_API> <PORTAL_API>`: Ubuntu 기계 원샷 배포(docker 설치·사양별 파리 수·`.env`·빌드·`bench`·기동).
  `npm run fly bench`: 이 기계의 뇌 스텝 ms → 파리 수 추천(0.5코어 예산). `docker-compose.remote.yml` = 거래소가 다른 호스트.
- 거래소 FE의 `/fly` 페이지(`bitshuriken-prod-fe/src/components/fly/*`, `lib/api/fly.ts`)가 `NEXT_PUBLIC_FLY_API_URL`
  (기본 http://localhost:5130)로 `GET /api/league`·`/api/fly/:slot`을 읽는다 — JSON API는 CORS `*`(읽기 전용 관전 데이터).

## 규칙
- 라이브는 `FLY_INTERVAL`(1m) 모델이 있어야 한다 — 모델은 (심볼, interval) 단위. 커넥톰이 바뀌면(재빌드) 재학습.
- 라이브 책은 별개 bots 서비스의 미러가 만든다 (`cd ../bitshuriken-prod-bots && npm run bots`). 티커 활성화도
  fly 밖(admin). `scripts/exchange.sh stop`은 fly를 죽이지 않는다 — `live`는 Ctrl-C로 끝내고 포지션은 유지된다.
- `data/`(원본 CSV·커넥톰·모델·라이브 상태)는 gitignore. 서브계정 secret 평문 저장(dev 한정).
- 예측력은 주장하지 않는다 — `train`의 val IC·hit rate와 out-of-sample 백테스트가 판단 근거이고, 결과는
  docs/trading/journal.md에 남긴다. 첫 결과(09-16): val IC 0.04, 테이커 수수료 벽을 못 넘음 (lessons L1 재확인).
  요청 범위만, 정책 결정(초파리 계정의 수수료 티어·메이커 주문·레버리지 등)은 유저 확정 후.
