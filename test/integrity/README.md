# Live integrity harness

Plain-Node scripts that drive the **running** services over real HTTP (HMAC-signed) and assert
money-path integrity end-to-end: **BE → Kafka → Python match → settlement worker → DB**. Unlike the
`jest` e2e specs (which mock Kafka), these exercise the real matching engine. Money is checked with
exact `BigInt` scaled-by-10⁸ arithmetic — no floats.

Full results & rationale: `docs/test-reports/2026-06-16-exchange-integrity.md`.

## Prerequisites
All services up (see `CLAUDE.md` → "How to run"): spot 5101, futures 5102, portal 5103, **dex 5107**,
**options 5108**, Python match (`config/tickers.json`), Kafka 5113, Postgres 5110, mailpit 5111/5112.
The seeded admin (`admin@test.com` / `password123`) must exist (used to create the DEX pool).

> DEX/options need `PORT_DEX`/`PORT_OPTIONS` in `.env`; options must be built (`npx nest build options`).

## Run
```bash
node test/integrity/run-all.mjs     # all suites, aggregated summary (exit 1 on any failure)
# or individually:
node test/integrity/spot.mjs        # SYM=LTCUSDT by default (any bot-free spot ticker)
node test/integrity/dex.mjs
node test/integrity/portal.mjs
node test/integrity/futures.mjs
node test/integrity/options.mjs
```

## Files
- `lib.mjs` — toolkit: HMAC signing (`HMAC-SHA256(queryString+rawBody, secret)`), `signup`/`login`/`issueApiKey`/`deposit`/`transfer`/`verifyEmail` (via mailpit), exact 8dp `toScaled`/`fromScaled`, and a tiny PASS/FAIL reporter.
- `spot.mjs` `dex.mjs` `portal.mjs` `futures.mjs` `options.mjs` — one suite per product. Each prints `REPORT_JSON <…>` for the runner.
- `run-all.mjs` — runs every suite as a child process and prints a combined summary.
- `_probe.mjs` — scratch probe for the harness primitives.

## Design notes
- **Isolation:** suites use bot-free tickers (e.g. `LTCUSDT`) so two test users cross only each other → true two-sided conservation. Each case creates fresh users and funds them via the dev deposit + transfer endpoints, so runs are independent and repeatable. (They do create throwaway `*@itest.local` users + a persistent `ATOMUSDT` DEX pool — dev-DB only.)
- **Async settlement:** matching/settlement is eventually-consistent (~100ms). Suites poll order/position state and balances rather than reading immediately after a mutation.
- **Conservation pattern:** assert `Δ(partyA)+Δ(partyB) == −fees` per asset, exact to 1e-8. DEX adds the `k`-non-decreasing invariant; futures adds `wallet == Σ FuturesIncome` at flat + PnL zero-sum.
- **Options** is read/intake-only (end-to-end blocked — no listed series / no options match lane).
