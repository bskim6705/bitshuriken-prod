# bitshuriken-prod-bots

Binance/Upbit-mirroring maker/taker bots + a monetary-integrity checker for **bitshuriken-prod**.

The bots are **ordinary users** (feedback-025): every order/funding call is an HMAC-signed API-key
request over the same public surface a real client would use — no backend coupling, no direct engine
or DB writes. Market-making accounts are made **rate-limit exempt** at boot via the operator surface.

## What it does
- **MakerBot** mirrors an external top-N book as resting `LIMIT GTC` orders (min-diff reconcile loop).
- **TakerBot** replays external trades as `MARKET IOC` (per-side qty buffers, TPS cap, per-order cap
  at a fraction of the local best level → prints stay at top-of-book ≈ source price).
- Two identities (`maker-bot` / `taker-bot`) so every fill is maker↔taker across different users.
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
