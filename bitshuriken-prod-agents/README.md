# bitshuriken-prod-agents

Multi-strategy trading-agent framework for the bitshuriken-prod exchange. Run many
strategies side by side, **each as its own funded subaccount**, forward-test them live
against the running exchange and backtest them over real Binance history, and drive the
whole fleet in real time from an LLM (Claude) over **MCP** — observe, tune, add, compare
strategies, and hunt for new signals.

It is a semantic fork of `bitshuriken-v2-agents` (design: v2 ADR-050 agents framework,
ADR-049 subaccounts, ADR-059 dashboard + integrity). It attaches to the exchange **from
the outside, as a normal user** — public market APIs + authenticated HMAC order APIs only,
no BE-internal calls, no DB writes, no engine Kafka (feedback-025 "봇도 유저다"). It is a
separate service that owns its own deployment (feedback-023).

## How it works

```
                 ┌────────────── agentd (daemon, always-on) ──────────────┐
   Claude ──MCP──┤  control API + dashboard (node:http :5120)              │
   CLI    ──HTTP─┤   • Supervisor: master(JWT) → subaccount per strategy    │
                 │   • each agent: Strategy + LiveBroker(HMAC) + BarClock    │──▶ prod exchange (be-*)
                 │   • backtest: Strategy + SimBroker over Binance history   │──▶ Binance (ccxt)
                 │   • JSON results store (data/, gitignored)                │
                 └──────────────────────────────────────────────────────────┘
```

- **One strategy = one subaccount.** The package owns a single **master** account (it
  never trades). Starting an agent creates a subaccount under the master (`POST
  /subaccounts`), funds it (master `POST /account/deposits` → `POST /subaccounts/transfers`),
  issues it a trade+read **API key** (`POST /subaccounts/{id}/api-keys`), and the agent
  trades/reads with **HMAC**-signed requests. Balances, orders and PnL are isolated by the
  subaccount's `userId` automatically (prod ADR-049).
- **HMAC auth (Binance-style).** Canonical string = `queryString(without signature) + body`,
  HMAC-SHA256 hex; headers `X-API-KEY`; query `timestamp` / `recvWindow` (≤60000) /
  `signature`. This exactly matches the backend's `ApiKeyOnlyGuard`.
- **Same strategy, live or backtest.** A strategy only touches an `ExecutionContext`.
  `LiveBroker` routes to the exchange over HMAC REST; `SimBroker` fills deterministically
  over historical bars (latency / slippage / fee). One file runs unchanged in both.
- **Live bars** come from the prod exchange klines (`/spot/market/klines`) — what agents
  actually trade on. **Backtest + signal discovery** use deep **Binance** history via ccxt
  (`fetchOHLCV`, paginated), since the local stack only has klines since it started.
- **Liquidity on demand.** A live agent needs a book to trade against, so the daemon can
  activate a ticker (admin `X-Admin-Secret`) and — if the separate **bots** service is
  present at `BOTS_DIR` — spawn a Binance mirror per symbol.

Ships three strategies: `momentum` (EMA-cross + RSI), `grid` (long-only spot grid, onFill
ladder), and `buy-and-hold` (the comparison baseline). The LLM authors more.

## Prerequisites

The backend must be running (`bitshuriken-prod-infra`, or the dev stack + `./scripts/up.sh`
in the umbrella) and the tickers seeded. For a **live** book with liquidity, also run the
separate bots service (otherwise live agents start fine but have nothing to trade against).
**Backtests need only Binance reachability** — no local stack required.

## Setup

```bash
cd bitshuriken-prod-agents
npm install
cp .env.example .env   # defaults target the local dev stack (localhost:5101/5102/5103)
```

## Run

```bash
# 1. the daemon — owns the fleet + control API + dashboard (keep it running)
npm run daemon
#    → open the management dashboard at http://127.0.0.1:5120

# 2. drive it from the CLI (separate shell)
npm run cli status
npm run cli start momentum BTCUSDT capital=50000     # creates+funds a subaccount, starts forward-test
npm run cli start momentum BTCUSDT fast=8 slow=21     # a second agent, different params
npm run cli start buy-and-hold BTCUSDT               # the baseline
npm run cli agents
npm run cli tune <agentId> riskFrac=0.4              # live-tune, no restart
npm run cli compare                                  # ranked table (baseline = buy-and-hold)
npm run cli integrity [<agentId>]                    # ledger↔balance reconciliation + health
npm run cli stop <agentId>

# 3. provision live liquidity (needs the separate bots repo at BOTS_DIR), then run a grid
npm run cli mirror BTCUSDT                            # spawn a bots Binance mirror
npm run cli start grid BTCUSDT capital=50000          # grid agent trades the mirrored book
#   or in one step:  npm run cli start grid BTCUSDT mirror=true

# 4. backtest (no daemon needed) — over 60 days of 1h Binance history
npm run backtest momentum BTCUSDT 1h 60
npm run backtest grid BTCUSDT 1h 60 spacingPct=0.003

# 5. signal hunting
npm run cli scan BTCUSDT 1h
```

### Dashboard

The daemon serves a management dashboard at `http://127.0.0.1:5120` (same origin as the
control API — no CORS, no build step; static `web/` served by `agentd`). It shows running
**agents**, the **performance ranking** (성과 순위 — Sharpe / ROI / PnL vs the buy-and-hold
baseline), per-agent **integrity** (정합성), and an agent detail view with its equity curve.
Auth-less (internal dev tool) — never expose it; reach over an SSH tunnel in prod.

### Integrity (정합성 — accounting cross-check)

Each isolated subaccount starts with a known initial USDT capital and trades one symbol, so
its ledger fully explains its balances. The integrity check replays the subaccount's
`/account/trades` from initial capital (modelling quote/base commission) and reconciles the
reconstructed balances against live `/account/balances` — **drift = a settlement / accounting
bug in the exchange** (prod ADR-049 isolated accounts make a natural test harness). Plus
operational health: running state, consecutive errors, bar freshness, equity sanity. Headless
via `npm run cli integrity` or `GET /integrity`.

## Connect the MCP server

The MCP server is the LLM's control surface (a thin adapter over the daemon — **start the
daemon first**). Runs via `tsx`, no build step:

```bash
claude mcp add bitshuriken-agents -- npx -y tsx /absolute/path/to/bitshuriken-prod-agents/src/mcp.ts
```

Tools: `list_strategies`, `reload_strategies`, `list_agents`, `start_agent`, `stop_agent`,
`tune_agent`, `get_metrics`, `compare`, `run_backtest`, `fetch_klines`, `compute_indicators`,
`signal_scan`, `scaffold_strategy`, `list_tickers`, `ensure_ticker`, `start_mirror`,
`stop_mirror`, `list_mirrors`.

## Authoring a new strategy

1. `signal_scan` / `compute_indicators` / `fetch_klines` to find an edge.
2. `scaffold_strategy` → a template; write it to `src/strategies/<name>.ts`.
3. `reload_strategies` → it's registered (dynamic import, no daemon restart).
4. `run_backtest` to validate, then `start_agent` to forward-test, then `compare`.

A strategy default-exports a `StrategyFactory` (`{ id, paramSchema, create() }`) and
implements `Strategy` (`init` / `warmup` / `onBar` / `onTick?` / `onFill?` / `applyParams`),
submitting `OrderIntent`s (`MARKET` / `MARKET_QUOTE` / `LIMIT` / `CANCEL` / `FLATTEN`) through
the `ExecutionContext`. See `src/strategies/momentum.ts`.

## Deployment

Own `Dockerfile` + `docker-compose.yml`. The compose attaches to the exchange's external
network `bitshuriken_internal` and reaches the backend by internal DNS (`be-spot:5101`,
`be-futures:5102`, `be-portal:5103`). Bring the core stack up in `bitshuriken-prod-infra`
first, then `docker compose up -d --build` here (feedback-023: agents is NOT in the infra
compose).

## Known limitations

- **Live is SPOT-only.** Futures trade-replay doesn't produce fills yet (engine gap; prod is
  spot-first, ADR-004); live `start_agent` refuses `FUTURES`. Backtests support futures.
- **Live needs liquidity.** Agents trade against a bots mirror — the bots service deploys
  separately (feedback-023/025) and must be present at `BOTS_DIR` to spawn a mirror. Ticker
  activation works without it.
- **Subaccount API secrets are stored** in `DATA_DIR` (gitignored) so the daemon can resume
  agents after a restart. Dev-only.
- **Rate-limit exemption is deferred.** By default agents are normal-user traffic
  (feedback-025). Setting `AGENT_INTERNAL_TOKEN` = the backend's `RATE_LIMIT_INTERNAL_TOKEN`
  attaches `X-Internal-Token` to exempt them, but the exemption policy (market-making accounts
  only?) is a user-confirmed decision (feedback-016).
- **Hot-reload caveat.** `reload_strategies` cache-busts the import, but already-running agents
  keep their instance (reload affects future starts).

## Layout

```
src/
  config.ts            env loader (lazy — backtest never touches the live exchange)
  core/                exchange (MasterClient JWT + SubaccountClient HMAC), admin (X-Admin-Secret), binance (ccxt history), precision, types, logger
  data/marketdata.ts   klines (local|binance) + indicators
  indicators/          ma, rsi, atr, series, scan (signalScan)
  strategy/            types (Strategy/ExecutionContext contracts), sizing, registry (dynamic import)
  strategies/          momentum.ts, grid.ts, buy-and-hold.ts
  broker/              live.ts (HMAC REST + fill polling), sim.ts (deterministic backtest fills)
  metrics/             compute (pure), live (from BE), integrity (ledger↔balance recon + health), compare, store (JSON), types
  fleet/               supervisor, agent (runner), barsource (BarClock), bot-manager (mirror spawn), state
  control/             server (node:http API + static dashboard), client
  backtest/engine.ts   runBacktest (shared by CLI + daemon)
  daemon.ts cli.ts mcp.ts backtest-cli.ts
web/                   management dashboard (vanilla HTML/CSS/JS, served by agentd)
```
