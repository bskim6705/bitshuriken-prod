# Exchange Feature & Integrity Test Report — 2026-06-16

> **[bitshuriken-prod fork note, 2026-07-03]** 이 리포트는 포크 이전(options/DEX 포함 시점)의 기록이다. 이 포크에는 spot/futures/portal만 존재한다.

Scope: every exchange product — **spot, futures, portal (auth/wallet/transfers/subaccounts/leaderboard/admin/funding), DEX, options** — plus the existing automated suites, a new **live** integrity harness, and a frontend smoke test. Bots/agents were excluded from integrity testing per request. Verified, working state was reflected back into the API docs.

**Headline:** unit **253/253**, e2e **51/51**, live integrity **114/114**, frontend **all pages render with live data, 0 console errors**. No production money-path bug surfaced. The one corrected doc is options (now marked *preview / non-operational*).

---

## 1. Method

Two layers, because the existing e2e suite **mocks Kafka** and therefore never exercises the real matching engine:

1. **Existing automated tests** (`jest`) — unit specs + e2e specs (Kafka mocked).
2. **New live integrity harness** (`bitshuriken-v2-be/test/integrity/`) — plain Node scripts that drive the **actually-running services** over real HTTP (HMAC-signed), so every assertion travels the full path **BE → Kafka → Python match → Kafka → settlement worker → DB**. Money math is checked with exact `BigInt` scaled-by-10⁸ arithmetic (no floats), mirroring `libs/shared/src/decimal.ts`.

### Environment
- Services: spot `5101`, futures `5102`, portal `5103`, **dex `5107`**, **options `5108`**, Python match (`config/tickers.json` = 12 spot + 2 futures), Kafka, Postgres `5104`, mailpit `5105/5106`, FE `5100`.
- DEX (`PORT_DEX`) and options (`PORT_OPTIONS`) were not running at start — added the two local ports to `bitshuriken-v2-be/.env` and started both apps (options needed a `nest build options` first). No other env changes.
- Isolation strategy: tests run on **bot-free tickers**. Bots only quote `BTCUSDT/ETHUSDT/SOLUSDT` (spot) and `BTC/ETH` (futures), so `LTCUSDT` spot has an empty book → two test users cross only each other. The futures book is currently idle, so the same two-user crossing works there too.

---

## 2. Existing automated tests

Both suites were **failing on first run** — every failure was **stale test scaffolding**, not a product bug. Fixed (test-only changes, no production code touched) and re-run green.

| Suite | Before | After | Root cause of failures |
| --- | --- | --- | --- |
| Unit (`npm test`) | 231/253 | **253/253** | mocks missing newly-added deps: `tickerStats.assertTradable` + `users.assertCanTrade` (OrderService/OrderListService gained a listing-status gate + per-account trade gate); funding mock missing `withdrawalEnabled` |
| E2e (`npm run test:e2e`) | 37/51, 4 suites errored | **51/51, 4/4** | `beforeAll` exceeded the 5s default hook timeout under load (module bootstrap); `afterAll` deleted `User` before `AuthToken` (signup now mints an email-verify token) → FK violation |

Fixes: added the missing mock methods/fields; `testTimeout: 60000` in `test/jest-e2e.json`; delete `authToken` before `user` in the three e2e teardowns.

---

## 3. Live integrity tests — 114/114 PASS

Harness: `bitshuriken-v2-be/test/integrity/` (`node test/integrity/run-all.mjs`). Per-product breakdown of the invariants proven against the live pipeline:

### SPOT — `spot.mjs` (LTCUSDT) · 31/31
- **Money conservation:** for a maker/taker cross, `Δ(maker)+Δ(taker) == −fees` for both base and quote, exact to 1e-8. The only value leaving the two traders is commission to the fee sink.
- **Lock/reserve:** LIMIT SELL locks exactly `origQty` base; LIMIT BUY locks exactly `price×qty` quote; cancel releases the full lock and restores free balance (cancel is **async** — refund lands on the engine's CANCELED ack).
- **Fees:** maker/taker 10 bps each, charged on the received asset (BUY→base, SELL→quote), matching `Trade.maker/takerCommission`.
- **Partial fill:** half-fill then cancel refunds the unfilled remainder exactly.
- **MARKET BUY (quote-driven):** stepSize floor + **dust refund** — `cumulativeQuoteQty == price×executedQty`, unspent quote returned, `dust < price×stepSize`.
- **Guards:** sub-`minNotional` rejected (40009); FOK with no full fill → not filled, balance untouched.

### DEX (AMM) — `dex.mjs` (ATOMUSDT pool) · 27/27
- **Gold-standard conservation** (synchronous, no bots): swap is exact zero-sum between trader and pool reserves for both assets.
- **Constant product:** `k` is **non-decreasing** after every swap (fee retained in reserves for LPs); `GET /dex/quote` == executed `outQty`; output matches `rOut·aInWithFee/(rIn+aInWithFee)`.
- **LP accounting:** add-liquidity mints shares `== totalShares·baseAdded/reserveBase`; remove-liquidity pays out proportionally; **round-trip `out ≤ in`** (floor rounding favors the pool by ≤1e-8 — the floor8 payout invariant).
- **Slippage:** swap with impossible `minAmountOut` rejected, no state change.

### PORTAL — `portal.mjs` · 21/21
- **Deposit/withdraw ledger** matches wallet delta exactly; withdrawal is correctly **gated on email verification** (token pulled from mailpit and confirmed in-test), then debits exactly.
- **Cross-market transfers** (SPOT↔FUTURES↔DEX) conserve total balance exactly.
- **Subaccounts:** master→sub transfer conserves funds; an unrelated user **cannot read or transfer out of** another's subaccount (isolation).
- **API-key scope:** read-only key blocked from TRADE (60008); no-read key blocked from READ (60009); bad signature and stale timestamp → 401; API key **cannot create subaccounts** (JWT-only escalation block).

### FUTURES — `futures.mjs` (BTCUSDT) · 20/20
- **Mark price** seeded by forcing a spot trade (index = EMA of spot trades); gated everything on it.
- Two users open **LONG/SHORT** then close. **Ledger conservation:** at flat, `futures wallet == Σ FuturesIncome` (TRANSFER + COMMISSION + REALIZED_PNL all journaled) for both sides.
- **PnL zero-sum:** `A_realized + B_realized == 0`; long-up profits, short loses equally; system total `== deposited − total commission`.
- **Margin reserve:** `isolatedMargin == ceil8(notional/leverage)` (the ceil8 charge invariant).
- **Guards:** leverage > maxLeverage(50) rejected; leverage change while a position is open rejected (flat-only); over-margin open rejected (insufficient balance).

### OPTIONS — `options.mjs` · 15/15 (read + intake only; **e2e BLOCKED**)
- All market/account read endpoints serve cleanly with an empty chain; order-intake rejects an unknown instrument with 4xx (not a crash).
- **End-to-end is blocked** (see §6).

---

## 4. Frontend (Playwright, FE `5100`)

Logged in as a funded test user and exercised the UI; every page rendered with **live** data and **0 console errors**:
- Landing (live top markets), login flow, markets.
- **Spot trade** — placed a real LIMIT order via the UI, saw it in Open Orders, cancelled it (full round-trip).
- Wallet (live balances + valuations), Futures (live mark/index + my test fills), DEX swap (live pool matching the integrity test), Account (profile + 0.10%/0.10% fee tier), Leaderboard (live volumes incl. test users), Swagger api-docs.

UI note: the landing page house-rule/FAQ still says *"Futures module is stubbed"* — **stale copy**; futures is fully functional (cosmetic, FE-only).

---

## 5. API docs reflected

Docs are Swagger/OpenAPI generated from controller decorators, served at `/docs` + `/docs-json` per app and unified in the FE `/api-docs` (Scalar). The spot/futures/portal/DEX docs already accurately describe the verified, operational surface. The one misleading doc — **options**, which implied a working exchange — was corrected to a **"preview / non-operational"** status string (`apps/options/src/main.ts`), rebuilt and redeployed; confirmed live in `/docs-json`.

---

## 6. Findings & notes

**Verified blockers / gaps**
- **Options e2e is blocked** (structurally complete, operationally inert): 0 `OptionSeries` rows and **no code path creates them** (exhaustive grep), the running match has no options lane, and SELL-open (writing) is explicitly Phase 4. Only reads + intake validation are testable. Now documented in the API description.
- **Stale tests** (now fixed) had drifted behind features (listing gate, account trade gate, email-verify token, withdrawal gate). Worth a CI run to prevent recurrence.

**Design characteristics observed (not bugs, by design for this closed-loop dev venue)**
- Order **cancel is asynchronous** — the lock refund lands on the engine's CANCELED ack, not on the cancel HTTP response. Clients must poll/await.
- Dev **deposit is an instant unlimited mint** via any TRADE-scoped key (closed-loop testnet funding model).
- Withdrawals require a **verified email**; the email-verification token flow works end-to-end (mailpit).

**Not independently re-verified here** (from the code-mapping pass, flagged for follow-up): no self-trade prevention; cancel-replace is non-atomic (locks transiently coexist); futures funding net-zero couldn't be triggered on-demand (cron 00/08/16 UTC); a futures fill can drive a balance negative on shortfall (logged, not blocked).

---

## 7. Reproduce

```bash
# backend (all 5 apps + match + docker infra must be up; see CLAUDE.md "How to run")
cd bitshuriken-v2-be
npm test                          # unit  → 253/253
npm run test:e2e                  # e2e   → 51/51
node test/integrity/run-all.mjs   # live  → 114/114   (see test/integrity/README.md)
```
