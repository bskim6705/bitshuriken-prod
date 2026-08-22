# bitshuriken-prod-bots

Binance/Upbit-mirroring maker/taker bots + a monetary-integrity checker for **bitshuriken-prod**.

The bots are **ordinary users** (feedback-025): every order/funding call is an HMAC-signed API-key
request over the same public surface a real client would use — no backend coupling, no direct engine
or DB writes. Market-making accounts are made **rate-limit exempt** at boot via the operator surface.

## What it does
- **MakerBot** mirrors an external top-N book (default 50 levels — deep enough that a fast move
  churning the whole visible top-20 still leaves a full book; Upbit caps at its venue max of 30
  via a dedicated `.30` depth socket) as resting `POST_ONLY` orders, event-driven: every
  depth update triggers a paced min-diff pass (cancel levels that left, place levels that entered,
  top up partially-filled qty), so the local book moves level-by-level like the source — never in
  full-book place/cancel waves. All cancels of a pass land before any place, and POST_ONLY makes
  the engine reject (not match) a still-crossing order, so the mirror cannot self-trade. A slow
  open-orders resync picks up partial fills, async PO rejects, and leaked orders.
- **TakerBot** replays external trades as `LIMIT IOC` capped at max(source print price, local touch)
  (per-side qty buffers, TPS cap). A source multi-level sweep sweeps the local book to the same
  price — wicks and candle H/L reproduce — while the limit price is a structural ceiling, so a
  print can never walk past the source price into deep resting orders (ADR-070).
- One maker + one taker account **per symbol** (`maker-btcusdt@bots.local` …, futures prefixed
  `-f-`), so fills are maker↔taker across different users and no two symbols serialize on one
  account's balances (ADR-070). Funding is idempotent (top-up below half target, periodic refill)
  and API keys persist in `.bot-keys.json` across restarts.
- **Feeds route by quote asset**: `USDT`/`USDC` → Binance (`binance` spot / `binanceusdm` perp),
  `KRW` → Upbit (spot only). KRW markets use Upbit's tiered price units (see `src/krw-ticks.ts`).

## Monetary integrity checker (`npm run check`)
Reads Postgres directly (cross-user totals have no REST endpoint) + hits public market data. Fails
(exit 1) on a monetary invariant, the "things a real exchange never does to money":
- **F1** spot ledger: every wallet's holdings == funding flows + realized trade effects − commissions;
  non-negative balances; `executedQty` == Σ trade legs.
- **F2** liquidation oracle: recompute each isolated position's margin ratio from the live mark price
  vs its maintenance rate — flags "underwater but still NORMAL" (missed liquidation) and the reverse.
- **F3** futures: `wallet + Σ isolatedMargin == Σ FuturesIncome`; realized PnL & funding zero-sum;
  per-symbol Σ position.qty == 0.
- **F4** frozen funds: `locked == Σ open-order + OCO locks` (a lock that wasn't released fails).
- **PARITY** (informational, never fails the run): local mid vs Binance/Upbit mid.

## Opportunity scanner (`npm run scan`)
Observation only (no orders): kimchi premium (KRW vs USDT×USDTKRW), perp basis + funding carry.

## Mirror-precision bench (`npm run bench`)
Observation only. Reproducible fidelity measurement (ADR-070): samples local vs source top-of-book
for `--minutes` (deviation percentiles in bps, spread), then compares the window's completed 1m
candles (H/L/C bps, volume ratio). `npm run bench -- --minutes 5 --out bench.json`. Fidelity claims
in reports should cite this bench. (`npm run fidelity` remains the quick one-shot mid/spread/depth
probe.)

## Run
```bash
cp .env.example .env      # set SPOT/FUTURES/PORTAL_API, DATABASE_URL, ADMIN_API_SECRET
npm install
npm run bots              # start mirroring (Ctrl-C cancels all maker orders)
npm run check             # one-shot integrity (exit 1 on a monetary fail)
npm run check -- --watch  # continuous
npm run scan              # opportunity scan
```
`SPOT_SYMBOLS` / `FUTURES_SYMBOLS` narrow the set; empty = mirror every ticker the exchange lists.

## Deployment
Own `Dockerfile` + `docker-compose.yml` (feedback-023): attaches to the external `bitshuriken_internal`
network and talks to `be-spot`/`be-futures`/`be-portal`, or point `*_API` at `https://bitshuriken.com/api`.

Design background: ADR-037 (mirroring + integrity test), ADR-066 (bots/KRW/tiered ticks),
feedback-024 (real-exchange bar), feedback-025 (bots are users).
