# ADR-037: Binance-mirroring bots & exchange integrity test

> **[bitshuriken-prod fork note, 2026-07-03]** `bitshuriken-v2-bots` 레포는 이 포크에 포함되지 않는다(아카이브 `bitshuriken-v2/`에 보존). 이 ADR은 무결성 테스트 설계의 배경과 BE의 `X-Internal-Token` 등 관련 표면의 유래를 설명하는 역사 기록으로 유지한다.

## Status
Accepted (2026-06-14)

## Context
Local/dev runs of the exchange start with an empty order book and no trades, so
the FE (order book, depth chart, kline chart, 24h ticker, recent trades) looks
broken and is hard to evaluate. We also lacked an automated way to assert the
exchange's accounting stays self-consistent under load.

The BE already exposes a Binance-shaped public market API (`/spot/market/depth`,
`/agg-trades`, `/klines`, `/book-ticker`, `exchange-info` with `tickSize`/
`stepSize`/`minNotional`) and the seeded tick/step precisions match Binance for
the mirrored symbols, so mirroring real Binance data maps onto the local engine
with no rescaling.

## Decision
Add a standalone TypeScript package **`bitshuriken-v2-bots`** (peer of `-be`/`-fe`/
`-match`) that drives the running exchange over its REST API as ordinary clients.

Binance market data is consumed via **ccxt** (`ccxt.pro` WebSockets), which
unifies the spot/futures stream differences (e.g. spot `@aggTrade` vs USDⓈ-M
`@trade`, which empirically does not deliver `@aggTrade`) behind
`watchOrderBook` / `watchTrades`, and keeps a synced book so each read is a
complete top-N snapshot.

- **MakerBot** mirrors `watchOrderBook` (top-N) as resting `LIMIT GTC` orders,
  reconciling the minimum diff on a throttled loop. This recreates the visible
  order book.
- **TakerBot** replays each `watchTrades` print as a `MARKET IOC` order against
  the maker book — driving trades, 24h volume, last price and klines. Binance
  trade rate is decoupled from local order rate via per-side qty buffers, a
  `maxTps` flush cap, and a per-order cap of a fraction of the local best level
  (keeps the print at top-of-book ≈ Binance mid).
- Two distinct bot identities (`maker-bot`/`taker-bot`) so every fill is
  maker↔taker across **different** users (no self-trade). Accounts are
  auto-created and funded via `/auth/signup` + `/account/deposits` (+ spot→
  futures `/account/transfers` for perps) on boot.
- An **integrity checker** (`npm run check [--watch]`) asserting:
  - INV-1 no wallet has negative `balance`/`locked`
  - INV-2 `executedQty` = Σ trade legs and ≤ `origQty`
  - INV-3 `cumulativeQuoteQty` = Σ price·qty
  - INV-4 (spot) `Wallet.locked` = Σ remaining locks of open LIMIT/POST_ONLY orders
  - PARITY local depth mid vs live Binance mid (bps) + local-book-not-crossed
  Invariants read Postgres directly (cross-user totals have no REST endpoint);
  parity reads local + Binance REST.

Scope: spot `BTCUSDT/ETHUSDT/SOLUSDT` + futures `BTCUSDT/ETHUSDT` perps, top-20
depth. All tunable via `.env`.

## Rationale
- **REST-client only, no BE coupling.** The bots are external actors, so they
  exercise the real order/settlement path and can't accidentally bypass it.
- **depth20 snapshots, not diff streams.** Each partial-depth message is already
  a full top-N snapshot, so the maker needs no order-book diff bookkeeping.
- **Separate maker/taker users.** Avoids self-trade, which is otherwise allowed
  (no STP) and muddies fill/lock accounting.
- **Buffer + caps on the taker.** Mirrors Binance volume faithfully without
  walking the thin mirrored book or melting the Kafka/engine path.
- **DB-level invariants.** Conservation/lock-accounting needs all-user state that
  the public API doesn't expose; querying Postgres is the pragmatic choice for a
  dev/test tool.

## Consequences
- Dev/demo gets a live, Binance-faithful book, trades, volume and charts; the
  empty-state UI problems are no longer hit in normal use.
- The integrity test is reusable in CI-style runs and already surfaced
  pre-existing accounting violations (negative `locked`, `executedQty` = 2×
  `origQty` on a matched buyer/seller pair) left by earlier ad-hoc testing —
  a double-settlement signature worth investigating separately.
- The bots create heavy churn on the dev stack; defaults are conservative and
  tunable. They write real rows to the dev DB (bot users, orders, trades).
- Not faithful at L2 (top-20 only) and the taker coalesces bursts, so absolute
  depth/volume differ from Binance; mid-price parity stays within a few bps.
- **Spot mirrors fully (book + trades + volume + klines).** Futures mirrors the
  book (parity within bps) but trade replay surfaced an engine-side gap: perp
  market orders are marked `FILLED` with `executedQty = 0` and produce no trades,
  so futures volume/last-price don't populate. Consistent with futures being
  mid-development; tracked separately, not a bot defect.
