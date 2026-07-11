# ADR-066: 미러링 봇 · KRW quote · 계단식 호가단위 · MM 레이트리밋 면제

## Status
Accepted (2026-07-12)

## Context
세 목표(정합성 측정 / Binance·Upbit 미러링 / 수익 전략 테스트)를 위해 아카이브(v2)의 미러링 봇·에이전트를
프로드 외부 클라이언트로 되살리고, Upbit(KRW 마켓)을 미러 대상에 추가한다. 유저 확정 정책(2026-07-12,
feedback-016): 봇도 유저(feedback-025), 시장 조성 계정 레이트리밋 해제, Binance+Upbit 실시간 미러링,
KRW quote 추가 + USDT/KRW 환전 마켓 상장, Upbit 계단식 호가단위 그대로 재현, 정합성 fail = 금전 불변식.

## Decision

### 1. 미러링 봇 = 외부 유저 서비스 (신규 레포 `bitshuriken-prod-bots`)
- v2 봇을 포크: ccxt.pro MakerBot(top-N 호가 미러링)/TakerBot(체결 리플레이). 자기 배포 소유, 코어 스택 밖에서
  `bitshuriken_internal`에 external로 붙는다 (feedback-023).
- **인증은 HMAC API 키** (v2의 세션 JWT에서 전환). 봇은 signup→키 발급→이후 전 거래를 서명 (feedback-025).
- **피드는 quote 자산으로 라우팅**: `USDT`/`USDC`→Binance(`binance`/`binanceusdm`), `KRW`→Upbit(spot). maker/taker는
  feed-agnostic이라 소스 추가가 격리된다.
- 정합성 체커 3계층 중 DB 불변식+패리티가 이 레포에 산다 (F1~F4).

### 2. KRW quote — 코어는 quote-agnostic
- KRW를 `Asset`(type `FIAT`, precision 0)로 신설. `AssetType`에 `FIAT` 추가.
- `USDTKRW`(base USDT / quote KRW) 등 KRW 마켓을 상장. 코어(Asset 1급·Ticker base/quote FK·Wallet 자산별,
  ADR-008)가 이미 임의 quote를 받으므로 스키마 구조 변경 없이 데이터로 상장. minNotional KRW=5000.
- 초기 상장 세트는 **가격 ≥1000원**(정수 tick)인 고가 마켓: USDTKRW/BTCKRW/ETHKRW/XRPKRW/SOLKRW (pricePrecision 0).
  sub-1000원 저가 코인은 tier tick이 소수라 더 큰 pricePrecision이 필요 — 필요 시 후속 상장.

### 3. Upbit 계단식 호가단위 — 고정 tickSize 근사가 아니라 tier 함수
- Upbit KRW tick은 가격대별 계단 함수다. 단일 `pricePrecision` tick으로 근사하지 않고, 가격 의존 tier 함수로
  검증한다. 위치: `libs/shared/src/constants/krw-tick.ts`(BE, Decimal), 봇은 `src/krw-ticks.ts`로 미러(동기 유지).
- BE `order-validation`은 KRW-quote 마켓에서 소수 자릿수 대신 **tier tick 정렬**(`isKrwTickAligned`)로 검증.
  엔진은 tick을 강제하지 않으므로(BE 소관, price_tick 미사용) **엔진 변경 없음**.
- exchange-info는 KRW 심볼에 `priceTiers`(tier 표)를 노출하고 `tickSize`는 최소 tick을 보고한다.
- tier 표는 Upbit KRW 참조 계단표(≥2M:1000, …, [1000,10000):5, [100,1000):1, …). 미러된 Upbit 가격은 이미
  tier 정렬돼 있고, 봇이 제출 전 `roundPrice`로 tier에 스냅하므로 BE·봇·소스가 내부 일관된다. 정확한 Upbit 실측
  tick과의 미세 차이는 표만 조정하면 되는 튜닝 포인트.

### 4. MM 레이트리밋 면제 = 계정 단위 플래그
- `User.rateLimitExempt` 신설(기본 false). API 키 인증 경로가 `req.user.rateLimitExempt`를 싣고, rate-limit
  인터셉터가 이를 면제 조건으로 인정 (기존 `X-Internal-Token`과 병행).
- 설정은 운영 표면: `POST /admin/users/:id/rate-limit-exempt` (ServiceOrAdminGuard — 세션 admin 또는
  `X-Admin-Secret`). 봇이 부팅 시 자기 maker/taker 계정을 `ADMIN_API_SECRET`로 면제 처리한다. 면제 설정은
  거래가 아닌 운영 행위라 feedback-025(거래만 유저 표면 강제)와 정합.

### 5. 정합성 fail = 금전 불변식 (F1~F4)
`docs/specs/mirror-trading-and-integrity-plan.md` §0/§3 정의. F1 장부 대사(지갑=funding+체결 원장), F2 청산
오라클(마크 재계산 vs status), F3 선물 원장(wallet+margin=Σ FuturesIncome, PnL·funding zero-sum, Σqty=0),
F4 frozen(locked=Σ오픈 잠금). 패리티(미러 이탈)는 warn.

## Consequences
- 스키마 변경(User.rateLimitExempt, AssetType.FIAT)은 마이그레이션 동반 — 유저가 `prisma migrate dev` 실행.
- KRW 계단표는 BE·봇 2곳에 중복 — 표 변경 시 동기 필요(코드 주석에 명시).
- Upbit는 spot 전용이라 KRW 선물은 없다(피드 그룹핑이 자동 배제).
- 전략 러너 `bitshuriken-prod-agents`(별도 레포)가 서브계정+HMAC로 이 위에서 전략을 돌린다(ADR-049/050 유산).
- 미해결(막지 않음): KRW 밸류에이션(리더보드가 USDT 가정, ADR-045/047) — 후속. USDT/KRW 환전 마켓 상장으로
  김프 차익 실현 경로는 확보됨.
- 봇/에이전트 레포는 GHCR 이미지·CI를 각자 소유(후속 인프라 작업).
