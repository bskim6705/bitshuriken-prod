# 2026-09-16 정리 감사 — 데드코드 · 중복 · 복잡도 (읽기 전용, 삭제 전 목록)

> 방법: 영역별 3개 감사(BE / FE / 엔진·bots·agents) + 리포 위생 수동 점검. 도구는 knip 6.35, jscpd 5.2, eslint `complexity`/`max-lines-per-function`/`max-depth` 오버레이, Python `ast` 스크립트, 자체 importer·i18n 스크립트. 모든 "확정" 항목은 도구 결과를 grep으로 재검증했고, 상위 항목은 별도로 한 번 더 검증했다. §1(Tier 1)은 2026-09-16 적용됐고(머리말의 게이트 결과 참조), §2~§4는 미착수 목록이다. 원시 산출물은 세션 스크래치패드 `cleanup/{be,fe,engine}.md`.
>
> 정책 경계: spot↔futures 병렬 구현의 중복은 **허용**(ADR-017, be CLAUDE.md) — 집계만 하고 추출 권고 없음. ADR-069 S0 폴백 경로는 **의도적 잔존**. Prisma enum·컬럼 제거는 마이그레이션(유저 실행). KRW 틱 테이블 BE↔bots 복제는 의도적 동기(ADR-066).

## 0. 한눈에

| 영역 | 확정 데드(참조 0) | 정리 후보 중복 | 복잡도 상위 | 유저 결정 필요 |
|---|---|---|---|---|
| BE (24.4k LOC) | 14건 (컨트롤러 2·서비스 1·메서드 5·export 2·헬퍼 4·에러코드 3·enum 1) | 같은 앱 내 12클러스터 | cx≥20 8함수, 100줄+ 10함수, 900줄+ 파일 2 | enum 제거(마이그레이션), S0 경로 제거, 에러표 변경 |
| FE (21.8k) | 파일 4(+연쇄 3) · export 9 · i18n 키 17 · CSS 2 · svg 5 | 12클러스터(≈-600 LOC) | cx 44/42 폼 2개, 813줄 파일 1 | ~~SiteGate~~(09-16 제거), `/portfolio` 노출, 선물 폼 정밀도 |
| 엔진 (1.4k) | 상수 2 · 쓰기전용 속성 2 · 재수출 5줄 | 1클론 + 루프 패턴 2 | `main()` 122줄/21분기 | combined 모드 제거 vs #31 수정 |
| bots | 파일 1 · export 2 · 설정 2 | 3클론 | `loadtest main` 210줄 | loadtest 스크립트 등록 |
| agents | 0 (knip 오탐 22 정정) | 57클론(parseArgs ×7, 부트스트랩 ×9, 전략 ×40) | `cli main` cx 33 | 전략 dedup vs 동결, bots↔agents 공통 패키지 |
| 리포 위생 | 구 워크플로 3 · 루트 파일 3 · docs 루트 handoff 3 | — | — | Zookeeper dev compose |

## 1. 즉시 삭제 가능 — 영향 0, 검증 완료 (Tier 1)

> **2026-09-16 적용 완료.** 아래 전부 제거·이동했다. 편차 2건: ① E3·E4는 `OrderBook(symbol, qty_step)`로 축소하면서 `build_lane(market, symbol, partition, qty_precision)`·`TickerAdd(symbol, partition, qty_precision)` 시그니처도 함께 줄였다(엔진은 tick을 검증하지 않으므로 `pricePrecision`은 config·컨트롤 메시지에 남되 무시된다). ② F2의 `use-transactions.ts`는 `TRANSACTIONS_KEY`만 남겼다. 게이트: BE jest 42 suites/419 tests + `tsc -p tsconfig.build.json` 0 (전체 tsconfig의 spec 타입 오류 5건은 손대지 않은 spec 파일의 기존 오류), FE `tsc`·`eslint src` 0, 엔진 pytest 179 passed + 1 xfail, bots `tsc --noEmit` 0. 삭제 26파일·수정 약 35파일(미커밋).

### BE
| # | 경로 | 내용 | 근거 |
|---|---|---|---|
| B1 | `apps/spot/src/consumer/match-result.controller.ts` (33L) | M1 이후 미배선 `@Controller` | 어떤 모듈의 `controllers:`에도 없음. 로직은 settle 컨트롤러가 보유 |
| B2 | `apps/futures/src/consumer/futures-match-result.controller.ts` (49L) | 동일 | 동일 |
| B3 | `apps/spot/src/app.controller.ts` | 핸들러 0인 Nest 템플릿 잔재 | `app.module.ts` 등록 2줄 함께 |
| B4 | `libs/core-domain/src/ledger/ledger.service.ts:174` `release()`, `:202` `forgetApplied()` | 호출 0 | spec 포함 0 (applied Set 무한 성장은 별건, 관찰 항목) |
| B5 | `libs/core-domain/src/ticker/ticker.service.ts` `TickerService` | 주입처 0 | `ticker.module.ts` providers/exports만 |
| B6 | `libs/core-domain/src/user/user.service.ts:70` `findOne()` | 호출 0 | |
| B7 | `apps/futures/src/mark-price/mark-price.service.ts:211` `peekPremiumSamples()` | 참조 0 | |
| B8 | `libs/infra/src/messaging/topics.ts:35` `bookTopic()`, `:44` `ALL_OUTBOUND_TOPICS` | export 참조 0 | be·bots·agents·infra·scripts 전부 0 |
| B9 | `libs/core-domain/src/ledger/journal-writer.ts:16-21` `SourceKey.spotTrade/dustRefund/listRefund/funding` | 호출 0, `funding` 포맷은 실제 키와 불일치 | 실제 키는 리터럴 |
| B10 | `libs/core-domain/src/ledger/drift-checker.ts:105-113` `parseKey` | `ledger.types.ts:62` `parseLedgerKey`와 바이트 동일 | import로 대체 |

### FE
| # | 경로 | 내용 |
|---|---|---|
| F1 | `src/lib/dex-math.ts` (96L) | v2 DEX 잔재, import 0 |
| F2 | `src/components/wallet/history-table.tsx` (231L) + 연쇄 `lib/hooks/use-transactions.ts:11 useTransactions()`·`lib/api/transactions.ts`·`lib/types/funding-tx.ts` | `unified-history-table`이 대체. 단 `TRANSACTIONS_KEY` 상수는 transfer-modal·use-funding이 쓰므로 유지 |
| F3 | `src/components/landing/volume-stat.tsx` (33L) | `market-stats.tsx`가 대체 |
| F4 | `src/lib/i18n/index.ts` | 배럴, `from "@/lib/i18n"` 0건 |
| F5 | export 9종: `lib/api/futures.ts` REST 폴백 6(`fetchFuturesTickers/Depth/RecentTrades/BookTicker`, `fetchMarkPrice`, `fetchFundingRate`), `use-market.ts:175 useBookTicker`, `use-trading.ts:236 useOrderLists`(+`api/account.ts:53 fetchOrderLists`), `format.ts:23 formatQty`, `admin/ui.tsx:74 SkeletonRows`, `ui/inline-error.tsx:21 StatusText`, 타입 `MiniTicker`·`ListStatusEvent` | 참조 0 |
| F6 | `messages/common.ts` 17키 (`submit, delete, create, retry, back, continue, search, refresh, remove, add, viewAll, error, noData, none, required, optional, amount`) | 4로케일 동시 제거. 범용 어휘라 "유지" 선택도 가능 |
| F7 | `globals.css` `--color-up-soft`, `@utility label-xs` | 사용 0 |
| F8 | `public/{file,globe,next,vercel,window}.svg` | create-next-app 잔재 |
| F9 | FE `README.md` | create-next-app 보일러플레이트(localhost:3000, Vercel) → 프로젝트 README로 교체 |

### 엔진·bots
| # | 경로 | 내용 |
|---|---|---|
| E1 | `messaging/topics.py:15-16` `MARKET_SPOT/MARKET_FUTURES` | 참조 0 |
| E2 | `schemas/messages.py:13-15,200-212` OP_* 재수출 import + `__all__` | 소비자 0 (main·tests는 `messaging.topics`) |
| E3 | `engine/orderbook.py:23,28` `OrderBook.partition` | 쓰기 전용, 읽기는 전부 `lane.partition` — 테스트 생성자 10곳 수정 동반 |
| E4 | `engine/orderbook.py:25,31` `price_tick` | 쓰기 전용(엔진은 tick 검증 안 함) — 검증 계획 없으면 제거 |
| T1 | `bitshuriken-prod-bots/_cleanup_residual.ts` (42L, 추적 중) | 1행 "THROWAWAY", tsconfig 밖, 참조 0, `src/sweep.ts`가 상위 호환 |
| T2 | `bots/src/feeds/index.ts:39-42 restFeed`, `src/integrity/db.ts:29-30 worst` | 참조 0 |
| T3 | `bots/src/config.ts:43-44 makerEmail/takerEmail` + `.env.example MAKER_EMAIL/TAKER_EMAIL` | 읽기 0(이메일은 role·market·symbol로 파생, ADR-070) |

### 리포 위생
| # | 경로 | 내용 |
|---|---|---|
| R1 | `bitshuriken-prod-{be,fe,match}/.github/workflows/release.yml` | 루트 워크플로와 중복이고 GitHub이 읽지 않음(모노레포). 06 §2 B8 |
| R2 | 루트 `2026-07-12-mirror-and-strategy-report.md`, `2026-07-12-scalping-30min-results.md` → `docs/test-reports/`; `seed-tickers.sh` → `scripts/` | 이동 |
| R3 | `docs/handoff-2026-07-14{,-2}.md`, `docs/handoff-2026-08-19-mirror-goal.md` → `study/handoff/`(비공개, gitignore) | AI 세션 인수인계 메모라 공개 리포에서 제외. 링크 2곳은 평문으로 |
| R4 | `scripts/orphan-fix-2026-08-25.sql` | 참조 0인 일회성 SQL → `scripts/incident-2026-08-25/`로 |

## 2. 즉시 재사용·치환 — 같은 영역 안 copy-paste, 낮은 위험 (Tier 2)

### FE (★ = lib에 이미 있는데 재구현)
- ★ `wallet/funding-modal.tsx:21-35`, `wallet/transfer-modal.tsx:15,24-36`의 `NUMERIC_RE/isPos/decimalsOf/normDecimal` → `lib/hooks/use-order-form-state.ts:5-19` export 그대로 import.
- ★ `formatDateTime` 로컬 재구현 ×8(orders 3페이지, api-keys, unified-history-table, common/positions-panel, admin users·user-detail `fmtDate`) → `lib/format.ts:48 formatDateTime(value, {seconds?})`.
- `buildQuery` ×6(`lib/api/{account,account-history,futures,transactions,leaderboard,net-worth}.ts`) → `lib/api/query.ts`.
- BE 에러코드 리터럴 16회(`60010` ×6, `60011` ×7, 60014/15/16) → `lib/api/error-codes.ts`.
- `CopyButton` ×2(`api-key-secret-dialog.tsx:8-31`, `two-factor-dialog.tsx:62-85`) + 인라인 1 → `ui/copy-button.tsx`.
- 드롭다운 dismiss(바깥 mousedown + Escape) ×3(`notification-bell`, `language-switcher`, `common/symbol-header`) → `useDismissable`.
- `use-market.ts:87-173` ↔ `use-futures-market.ts:59-149`: `mergeKline`·`useKlines`·`useTrades` 본문 100% 동일(차이는 fetch 함수와 WS path) → `lib/ws/hooks.ts useWsStream(stream, path)`와 같은 path 파라미터 방식으로 통합(≈-90 LOC). spot↔futures지만 훅 수준 copy-paste라 정리 대상.

### BE (같은 앱 안)
- `portal/subaccount.service.ts:338-376` ≡ `portal/transfers.service.ts:146-186` `assertFuturesWithdrawable` 43L.
- `parseQty` ×3(portal admin·subaccount·funding service).
- futures `partitionOf` ×4(`futures-trading.service.ts:724`, `liquidation-executor.ts:547`, `futures-settlement.worker.ts:919`, `futures-order-dispatch.service.ts:27`).
- `futures-trading.service.ts:191-225` ≡ `:290-323` reduceOnly/maxNotional 검증 35L.
- `isUniqueViolation` ×5 → `libs/infra` 공용.
- `spot/settlement.worker.ts:443 walletKey` ≡ `ledger.types.ts:57 ledgerKey`.
- 상수 재선언: `FUNDING_INTERVAL_MS` ×2, `INSURANCE_FUND_EMAIL` ×3(→ libs/shared), `BPS_DENOMINATOR` ×4, `FUTURES_KINDS` ×4, `TERMINAL_STATUSES` 로컬 재선언(이미 export된 `TERMINAL_FUTURES_ORDER_STATUSES` 등).
- `.env.example`에 `MATCH_SPOT_PARTITIONS/MATCH_FUTURES_PARTITIONS` 누락(ADR-063 P 일치 규칙).

### 엔진·bots·agents
- `snapshot_store.py:132-140 ↔ 151-159` → `_publish_snapshot(lane)`; `producer.py emit/emit_keyed` 통합; `SCALE` 정의 단일화(`matcher.py:9`, `lane.py:14`, tests 6파일 → `scenario_support`가 이미 보유).
- `tests/` `book()/engine()` 픽스처 17쌍 동일 → `tests/conftest.py`.
- bots: `loadtest.ts:34-42 int()/num()` → `config.ts` 재사용; `"loadtest"` script 등록 + README(고아 엔트리).
- agents: `parseArgs()` ×7 + `mid()` ×5 → `core/cli-args.ts`(-60L); 서브계정 부트스트랩 ×9 → `core/bootstrap.ts`(-100L).

## 3. 구조 리팩터 — 복잡도·대형 파일 (Tier 3, 테스트 동반)

| 위치 | 지표 | 권고 |
|---|---|---|
| FE `components/futures/positions-panel.tsx` (813L) | 다이얼로그 3개 인라인(TpSl 107-250, Close 254-364, Margin 366-473) + intra-file 6클론 | 다이얼로그 파일 분리 + `PositionDialogFrame`(-370L) |
| FE `components/trade/order-form.tsx:78 OrderForm` | cx **44**, 450줄; `validate` cx 30 | 탭별 서브폼 + `validate` 분리 |
| FE `components/futures/order-form.tsx:257` | cx 42, 227줄 + Leverage/MarginMode 다이얼로그 인라인 | 다이얼로그 2개 분리 |
| FE 오버레이 다이얼로그 셸 ×8 파일 + 인라인 ×5 | Escape effect + `fixed inset-0 z-50` + `role="dialog"` 동일 | `ui/dialog.tsx` + `useEscapeKey`(-200~300L) — 위 두 항목의 선행 |
| FE orders 3페이지(`orders/{page,history,trades}`) | TABS/COLS/typeLabel/pairLabel/qtyDisplay/load-more 반복, cx 23/23 | `components/orders/{tabs,filter-bar,table-shell}` + `lib/orders-format.ts`(-250L) |
| BE `apps/futures/src/settlement/futures-settlement.worker.ts` (986L) | `applyTradeSide` 127L | 파일 분할(체결/펀딩/청산 인수)은 의미론 보존 필수 — 리팩터 전 spec 커버리지 확인 |
| BE `apps/spot/src/domain/order-list/order-list.service.ts` (853L) | `recoverList` cx 23, `createOcoList` 103L, S0/S2 이중 경로(225-262 ≡ 351-390) | S0 제거 결정(§4)과 함께 |
| BE `ticker-stats.service.ts:201 compose`, `:315 rollingWindowStats` | cx 29/29 | 윈도우 계산 분리 |
| BE `futures-market.gateway.ts:332 sendSnapshot` cx 24, `order-validation.ts:134` cx 22, `api-key-only.guard.ts:34` cx 20/88L | | |
| 엔진 `main.py:67 main()` | 122줄/21분기(부팅+시그널+핫루프 한 함수) | `boot()`/`handle_message()` 분리 → 회귀 테스트 가능 |
| 엔진 `snapshot_store.py:67 _restore_books` 53/15, `matcher.py:104 _has_full_liquidity` 27/13 | | FOK 갭(관찰 #30) 수정 시 함께 |
| bots `loadtest.ts:293 main` 210줄/~46분기 | 관찰 #28 수정 시 분리 | |
| agents `cli.ts:37 main` cx 33, `obook/run.ts:26` 107/31 | | |

## 4. 유저 결정 필요 (정책·마이그레이션·ADR급)

1. **`BalanceJournalKind.FUTURES_LIQUIDATION`**(`schema.prisma:560`) 제거 — 전 패키지 참조 0이지만 enum 값 제거 = 마이그레이션.
2. **에러코드 3개**(`SUCCESS`, `ORDER_ALREADY_CANCELED`, `ORDER_ALREADY_FILLED`) — 코드 사용 0, 공개 에러표(문서)에서 사라짐. `SUCCESS`는 `response.interceptor.ts:10` 리터럴 0을 대체하는 쪽도 가능.
3. **S0 폴백 경로 제거**(ADR-069 롤백 가역성): `order.service.ts:371 placeWithWallet`(90L), `order-list.service.ts:294 createOcoWithWallet`(118L), 양 워커의 S0 분기, `futures-trading.service.ts:587-691`, `margin.service.ts`, `useTruth` 6곳. 제거하면 §3의 대형 함수 다수가 함께 줄어든다. S2 실전 2개월(07-16~) — 롤백 가능성 판단.
4. **엔진 combined 모드**: 제거 시 `config/tickers.json` 746줄 + src 20~25줄 + 테스트 10줄 + 문서 3줄. **단 `bitshuriken-prod-be/prisma/seed.ts:12`가 이 파일을 티커 시드의 단일 소스로 읽는다** → seed를 분리 파일 2개로 바꾸거나 파일은 seed 전용으로 남기고 엔진 모드만 제거. 대안은 관찰 #31 수정(registry `(market,symbol)` + boot_hw `(topic,partition)`), 줄 수 비슷.
5. ~~**SiteGate**~~ — 2026-09-16 제거(컴포넌트·`messages/gate.ts`·layout 래핑, tsc·eslint 0).
6. **`/portfolio`**(`(app)/portfolio/page.tsx` 164L) — 인바운드 링크 0. 내비 노출 or 제거.
7. **선물 폼 정밀도**: `futures/order-form.tsx:303,340`·`positions-panel.tsx:54,275`가 `Number()` float 연산, spot 폼은 BigInt scaled — CLAUDE.md 정밀도 규칙 기준 통일(`lib/scaled.ts` 승격).
8. **bots↔agents 공통 패키지**: `ApiError/Envelope/ExchangeInfoSymbol` 26줄 바이트 동일, HMAC 서명, listenKey, placeMarket, precision 코어, 로거, env 헬퍼 — 9클론(≈150~200L). ADR-071 "독립 빌드" 방식과 맞는 형태(`packages/exchange-client`)로 ADR 필요. 공유 타입 7개는 이미 드리프트.
9. **agents 전략 40여 클론**(`dipladder↔martingrid` 39줄 등) — `strategy/ladder.ts` 베이스로 -300L 가능하나 EVO-7 실험 산출물. "패한 전략 동결"이 선행.
10. **deprecated fee bps**(`schema.prisma:46-48`, admin PATCH fee, FE admin·agents가 읽음) — ADR-073 티어 전환 후 잔존. 제거 = 마이그레이션 + FE + agents.
11. **dev compose Zookeeper**(`docker-compose.yml:14-29`, cp-kafka 7.5) vs prod KRaft(apache/kafka 3.8.1) — dev도 KRaft로 맞추면 `.env.example`의 5114 설명·exchange.sh 검증 갱신.
12. BE `package.json` `start:dev:*`/`start:debug:*` 6종 — 규칙 ⑤ "`--watch` 금지"와 충돌, settle 항목은 아예 없음. 삭제 or settle 추가.

## 5. 스테일 주석·문서 (코드 무변경, 바로 고칠 수 있음)

- BE: `ledger-projector.ts:14-15,30` "소유 앱만 실행"(M1 후 settle만 호출), `futures-ledger.scheduler.ts:10-14` "S0 러너/진실은 Wallet"(`LEDGER_TRUTH=true`와 모순) + `:38-39`·spot `ledger.scheduler.ts:33-34` 메서드 삭제 잔재, "S0 섀도/미러" 용어 8곳(`futures-app.module.ts:16`, `spot-ledger.module.ts:7`, `drift-checker.ts:9`, portal 4곳), `spot/settlement.module.ts:7` 존재하지 않는 "SettleWorkersModule", `apply-global-pipeline.ts:9` "5개 앱"(4), `journal-writer.ts:8-11` 배선 예정 주석, `eslint.config.mjs` `apps/dex/**` 죽은 규칙, `futures-ledger.wiring.spec.ts:68` describe "S0 wiring", BE `README.md` Nest 템플릿 원문, 코드 주석의 ADR 번호 다수(feedback-009).
- 엔진: `engine/orderbook.py:15-18` "1 partition = 1 ticker", `README.md:118` tid `{symbol}-{epoch}-{trade_seq}`(실제 `maker-taker`), `README.md:9-28,35` 모듈 트리 누락(lane/control/outbound/snapshot_store/order_codec), `CLAUDE.md:9,25` combined 모드 안내(#31 트랩).
- bots/agents: `feeds/index.ts:39` "for the parity checker", README/CLAUDE에 `sweep`·`loadtest` 미기재, agents `CLAUDE.md:28` "onFill은 폴링"(실제 WS 1차), `README.md:46-47,172` "three strategies"(21개), Layout 절 누락 5개.
- FE: `messages/widgets.ts:3` "옵션/DEX" 주석, `use-order-form-state.ts:76` 영문 폴백, `trade/order-form.tsx:38` vs `futures/order-form.tsx:39` `labelKey` 타이핑 불일치.

## 6. 하지 말 것 (오탐·정책)

- spot↔futures 병렬 클론: BE 27클론/542L, FE 래퍼 6쌍 — 정책 허용.
- agents knip "unused files" 23 중 22는 `strategy/registry.ts` 동적 import·정적 서빙 — 삭제 금지(knip entry 설정으로 소음 제거 가능).
- App Router 규약 파일(page/layout/error/route) 35개, `/reset-password`·`/verify-email`(메일 진입), `/admin/*`(직접 URL, 관리자 리다이렉트 보호).
- `MarkReader` null 바인딩(M1 의도), `OrderStatus.NEW/EXPIRED`·`CancelOrderMsg.u/s`(프로토콜 열거/계약), `Lane.__len__`(테스트 전용).
- 의존성: BE·FE·bots·agents 미사용 런타임 의존성 0. BE devDep `@eslint/eslintrc`만 미사용 후보(LOW).

## 7. 실행 순서와 게이트

1. **Tier 1 전부**(영향 0) → 게이트: BE `npm test`(42 suites), FE `npx tsc --noEmit` + `npx eslint`, 엔진 `pytest -q`(179+1), bots/agents `tsc`.
2. **§5 주석·문서 교정** — 코드 무변경.
3. **Tier 2 치환** — 파일 단위 커밋, 각 단계 같은 게이트.
4. **§4 결정 항목** — 결정된 것만. enum·fee bps는 마이그레이션 이름 제안 후 유저 실행.
5. **Tier 3 리팩터** — 다이얼로그 프리미티브 → positions-panel/order-form 분리 → orders 공통화 → 엔진 `main()` 분리 → BE 워커 분할(spec 커버리지 확인 후).
