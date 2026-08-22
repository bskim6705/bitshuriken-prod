/**
 * Synthetic load generator for bitshuriken-prod BE (spot or futures).
 *
 * Measures BE throughput ceiling and collapse behaviour WITHOUT the mirror bots — pure synthetic
 * order pressure through the ordinary user surface (HMAC API keys, feedback-025). Dedicated
 * `loadtest-N@bots.local` accounts (rate-limit exempt) churn place/cancel and self-cross fills at a
 * token-bucket-paced target TPS, with a bounded in-flight window so that when BE latency balloons the
 * dispatcher falls behind target — that gap is the collapse signal.
 *
 * Standalone: reuses LocalExchangeClient (identity/funding/trading) but touches nothing else. Only
 * BTCUSDT/ETHUSDT-style USDT symbols are used by default.
 *
 * FUTURES mode (LT_MARKET=FUTURES): funds each account's futures wallet (deposit→transfer), sets
 * leverage, and drives the same place/cancel + self-cross churn — but a cross opens/closes real
 * positions, so it exercises the settlement (margin/position/PnL) path. Futures LIMITs are validated
 * against the *mark* price (±5% band, not spot's ±10% around last) and require a mark price at all
 * (obs #20: a futures order 503s if the spot index hasn't formed) — so prices are seeded from
 * /futures/market/mark-price. Cleanup flattens tracked net positions via reversal self-crosses.
 *
 *   LT_MARKET=FUTURES LT_ACCOUNTS=2 LT_TPS=20 LT_DURATION_S=180 LT_SYMBOLS=BTCUSDT,ETHUSDT \
 *     LT_CROSS_PCT=20 LT_LEVERAGE=10 npx tsx src/loadtest.ts
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { config } from './config';
import { ApiError, LocalExchangeClient } from './exchange';
import { makeLogger } from './log';
import { floorQty, roundPrice } from './precision';
import type { Market, Side, SymbolSpec } from './types';

const log = makeLogger('loadtest');

// ---- parameters ----
function int(name: string, dflt: number): number {
  const v = process.env[name];
  const n = v === undefined ? dflt : Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function num(name: string, dflt: number): number {
  const v = process.env[name];
  const n = v === undefined ? dflt : Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
const LT_ACCOUNTS = int('LT_ACCOUNTS', 2);
const LT_TPS = num('LT_TPS', 20);
const LT_DURATION_S = num('LT_DURATION_S', 180);
const LT_SYMBOLS = (process.env.LT_SYMBOLS ?? 'BTCUSDT,ETHUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const LT_CROSS_PCT = process.env.LT_CROSS_PCT === undefined ? 20 : Number(process.env.LT_CROSS_PCT);
const LT_MARKET: Market =
  (process.env.LT_MARKET ?? 'SPOT').trim().toUpperCase() === 'FUTURES' ? 'FUTURES' : 'SPOT';
const IS_FUTURES = LT_MARKET === 'FUTURES';
const LT_LEVERAGE = int('LT_LEVERAGE', 10); // futures only

// ---- tuning constants ----
const USDT_FUND = '5000'; // per-account quote budget (human units)
const BASE_FUND_NOTIONAL = 10_000; // ~USDT worth of each base minted per account for self-cross sells (spot)
const FUTURES_MARGIN = '1000000'; // USDT deposited to spot then transferred to the futures wallet per account
const FUT_OFFSET_LO = 0.01; // futures resting offset 1–3% (inside the ±5% mark band)
const FUT_OFFSET_SPAN = 0.02;
const SPOT_OFFSET_LO = 0.03; // spot resting offset 3–5% (inside the ±10% last band)
const SPOT_OFFSET_SPAN = 0.02;
const RING_CAP = 20; // open resting orders per account before the oldest is cancelled (MM churn)
const PRICE_REFRESH_MS = 4_000; // public last-price cache cadence
const REPORT_MS = 5_000;
const PACER_MS = 5; // token-bucket tick
const MAX_INFLIGHT = Math.max(32, Math.ceil(LT_TPS * 3)); // backpressure → achieved<target on collapse
const PUBLIC_TIMEOUT_MS = 10_000;
const SUMMARY_DIR =
  '/private/tmp/claude-501/-Users-kitsune-bitshuriken-bitshuriken-prod/115634f2-a224-45c1-968e-4c1dfe3dd24b/scratchpad';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Account {
  client: LocalExchangeClient;
  ring: string[]; // resting place-cancel order ids (FIFO)
  net: Map<string, number>; // futures only: tracked signed net position per symbol (+long/-short)
}

// ---- metrics ----
const counters = {
  opsDispatched: 0, // token-bucket ops started (the achieved-TPS numerator)
  completed: 0, // successful API requests
  placeCancel: 0, // place-cancel ops
  cross: 0, // self-cross legs placed
  cancels: 0, // ring-eviction cancels
  errs: 0, // real BE/network errors
  timeouts: 0, // request abort (10s)
  skips: 0, // insufficient-balance (expected inventory exhaustion)
};
const allSamples: number[] = []; // successful request latencies (ms), whole run
const RESERVOIR_CAP = 500_000;
let windowSamples: number[] = []; // reset each report line

function recordLatency(ms: number): void {
  windowSamples.push(ms);
  if (allSamples.length < RESERVOIR_CAP) allSamples.push(ms);
  else {
    const i = Math.floor(Math.random() * counters.completed);
    if (i < RESERVOIR_CAP) allSamples[i] = ms;
  }
}

function classify(e: unknown): 'timeout' | 'balance' | 'err' {
  const name = (e as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (e instanceof ApiError && e.code === 30002) return 'balance';
  const msg = String((e as { message?: unknown })?.message ?? '').toLowerCase();
  if (msg.includes('insufficient balance')) return 'balance';
  return 'err';
}

/** run one API request, timing successes and classifying failures. Rethrows so callers can branch. */
async function timed<T>(fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const r = await fn();
    recordLatency(performance.now() - t0);
    counters.completed++;
    return r;
  } catch (e) {
    const c = classify(e);
    if (c === 'timeout') counters.timeouts++;
    else if (c === 'balance') counters.skips++;
    else counters.errs++;
    throw e;
  }
}

// ---- price cache (public ticker) ----
const priceCache = new Map<string, number>();
async function fetchLast(symbol: string): Promise<number> {
  // Futures orders are validated against the mark price (and 503 without one — obs #20), and the
  // futures 24h ticker's lastPrice is null until trades exist — so seed from mark price, not last.
  if (IS_FUTURES) {
    const res = await fetch(`${config.api.futures}/futures/market/mark-price?symbol=${symbol}`, {
      signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS),
    });
    const j = (await res.json()) as { data?: { markPrice?: string | null } };
    const p = Number(j?.data?.markPrice);
    if (!Number.isFinite(p) || p <= 0)
      throw new Error(`no mark price for ${symbol} (spot index not established — obs #20)`);
    return p;
  }
  const res = await fetch(
    `${config.api.spot}/spot/market/ticker?symbol=${symbol}&windowSize=1d`,
    { signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS) },
  );
  const j = (await res.json()) as { data?: { lastPrice?: string } };
  const p = Number(j?.data?.lastPrice);
  if (!Number.isFinite(p) || p <= 0) throw new Error(`no last price for ${symbol}`);
  return p;
}
async function refreshPrices(specs: SymbolSpec[]): Promise<void> {
  await Promise.allSettled(
    specs.map(async (s) => {
      try {
        priceCache.set(s.symbol, await fetchLast(s.symbol));
      } catch {
        /* keep last cached price */
      }
    }),
  );
}

// ---- order sizing ----
/** qty for ~1–2x minNotional at `price`, floored to step, bumped one step if it fell under. */
function pickQty(spec: SymbolSpec, price: number): string {
  const targetNotional = spec.minNotional * (1.1 + Math.random() * 0.9);
  let q = Number(floorQty(spec, targetNotional / price));
  if (q * price < spec.minNotional) q += spec.stepSize;
  return floorQty(spec, q);
}

function pickSymbol(specs: SymbolSpec[]): SymbolSpec {
  return specs[Math.floor(Math.random() * specs.length)]!;
}

// ---- ops ----
/** Place a non-crossing LIMIT (last ±3–5%), maintain the account's resting ring, evict oldest. */
async function opPlaceCancel(acct: Account, specs: SymbolSpec[]): Promise<void> {
  const spec = pickSymbol(specs);
  const last = priceCache.get(spec.symbol);
  if (!last) return;
  const side: Side = Math.random() < 0.5 ? 'BUY' : 'SELL';
  // resting offset stays inside the venue's price band (spot ±10% of last, futures ±5% of mark).
  const r = (IS_FUTURES ? FUT_OFFSET_LO : SPOT_OFFSET_LO) +
    Math.random() * (IS_FUTURES ? FUT_OFFSET_SPAN : SPOT_OFFSET_SPAN);
  const price = roundPrice(spec, side === 'BUY' ? last * (1 - r) : last * (1 + r));
  const qty = pickQty(spec, Number(price));
  let order;
  try {
    order = await timed(() => acct.client.placeLimit(spec, side, price, qty));
  } catch {
    return; // counted in timed()
  }
  counters.placeCancel++;
  acct.ring.push(order.id);
  if (acct.ring.length > RING_CAP) {
    const old = acct.ring.shift()!;
    try {
      await timed(() => acct.client.cancel(LT_MARKET, old));
      counters.cancels++;
    } catch {
      /* already gone (filled/cancelled); counted in timed() */
    }
  }
}

/** Self-cross: seller `a` rests a LIMIT, buyer `b` crosses at the same price → TR + wallet 4-leg. */
async function opCross(a: Account, b: Account, specs: SymbolSpec[]): Promise<void> {
  const spec = pickSymbol(specs);
  const last = priceCache.get(spec.symbol);
  if (!last) return;
  const price = roundPrice(spec, last * (1 + (Math.random() - 0.5) * 0.002)); // ±0.1%, near last
  const qty = pickQty(spec, Number(price));
  try {
    await timed(() => a.client.placeLimit(spec, 'SELL', price, qty));
    counters.cross++;
  } catch {
    return; // no base inventory (skip) or error — counted in timed(); don't leave a dangling BUY
  }
  try {
    await timed(() => b.client.placeLimit(spec, 'BUY', price, qty));
    counters.cross++;
    // Both legs at the same price cross fully. On futures that opens real positions (seller→short,
    // buyer→long); track the net so cleanup can flatten it (positions aren't readable here).
    if (IS_FUTURES) {
      const q = Number(qty);
      a.net.set(spec.symbol, (a.net.get(spec.symbol) ?? 0) - q);
      b.net.set(spec.symbol, (b.net.get(spec.symbol) ?? 0) + q);
    }
  } catch {
    /* counted in timed(); the resting SELL is swept at cleanup */
  }
}

/** Cancel every open order for one account+symbol. Spot has a bulk endpoint; futures has none on the
 *  client surface, so enumerate open orders and cancel each by id. */
async function cancelAllFor(acct: Account, spec: SymbolSpec): Promise<void> {
  if (spec.market === 'SPOT') {
    await acct.client.cancelAllSpot(spec.symbol);
    return;
  }
  const open = await acct.client.openOrders('FUTURES', spec.symbol);
  for (const o of open) await acct.client.cancel('FUTURES', o.id).catch(() => {});
}

/**
 * Futures only: flatten tracked net positions via reversal self-crosses (long account rests a SELL,
 * short account crosses with a BUY at mark → both positions net to ~0). Best-effort: positions can't
 * be read through the user surface here, so this trusts the cross-fill bookkeeping. Net per symbol is
 * conserved (sum across accounts = 0), so longs and shorts pair off exactly.
 */
async function flattenFutures(accounts: Account[], specs: SymbolSpec[]): Promise<void> {
  for (const spec of specs) {
    const sym = spec.symbol;
    const mark = priceCache.get(sym);
    if (!mark) continue;
    const price = roundPrice(spec, mark);
    const sellers = accounts.filter((a) => (a.net.get(sym) ?? 0) > 1e-9).map((a) => ({ a, q: a.net.get(sym)! }));
    const buyers = accounts.filter((a) => (a.net.get(sym) ?? 0) < -1e-9).map((a) => ({ a, q: -a.net.get(sym)! }));
    let i = 0;
    let j = 0;
    while (i < sellers.length && j < buyers.length) {
      const q = Math.min(sellers[i]!.q, buyers[j]!.q);
      const qStr = floorQty(spec, q);
      const qn = Number(qStr);
      if (qn >= spec.stepSize && qn * mark >= spec.minNotional) {
        try {
          await sellers[i]!.a.client.placeLimit(spec, 'SELL', price, qStr); // close the long
          await buyers[j]!.a.client.placeLimit(spec, 'BUY', price, qStr); // close the short
          sellers[i]!.a.net.set(sym, (sellers[i]!.a.net.get(sym) ?? 0) - qn);
          buyers[j]!.a.net.set(sym, (buyers[j]!.a.net.get(sym) ?? 0) + qn);
        } catch {
          /* best-effort — a residual position is reported, not fatal */
        }
      }
      sellers[i]!.q -= q;
      buyers[j]!.q -= q;
      if (sellers[i]!.q <= 1e-9) i++;
      if (buyers[j]!.q <= 1e-9) j++;
    }
  }
}

// ---- main ----
let stopping = false;
let inFlight = 0;

async function main(): Promise<void> {
  log.info(
    `params market=${LT_MARKET} accounts=${LT_ACCOUNTS} tps=${LT_TPS} duration=${LT_DURATION_S}s ` +
      `symbols=${LT_SYMBOLS.join(',')} cross=${LT_CROSS_PCT}%` +
      `${IS_FUTURES ? ` leverage=${LT_LEVERAGE}` : ''} maxInFlight=${MAX_INFLIGHT}`,
  );
  if (LT_SYMBOLS.length === 0) throw new Error('LT_SYMBOLS is empty');

  // 1. accounts: signup-or-login → API key → rate-limit exempt.
  const accounts: Account[] = [];
  for (let i = 0; i < LT_ACCOUNTS; i++) {
    const client = new LocalExchangeClient(`loadtest-${i}`);
    await client.ensureAccount(`loadtest-${i}@bots.local`, config.accounts.password);
    await client.ensureApiKey();
    if (config.adminSecret) await client.ensureRateLimitExempt(config.adminSecret);
    accounts.push({ client, ring: [], net: new Map() });
  }
  if (!config.adminSecret) log.warn('no ADMIN_API_SECRET — accounts not exempt (ok only if RATE_LIMIT_ENABLED=false)');
  log.ok(`${accounts.length} accounts ready`);

  // 2. resolve specs from exchange-info (feedback-021), then seed prices.
  const info = await accounts[0]!.client.exchangeInfo(LT_MARKET);
  const byName = new Map(info.map((s) => [s.symbol, s]));
  const specs = LT_SYMBOLS.map((n) => byName.get(n)).filter((s): s is SymbolSpec => {
    if (!s) log.warn(`symbol not listed on exchange, skipping: (unknown)`);
    return Boolean(s);
  });
  if (specs.length === 0) throw new Error('none of LT_SYMBOLS are listed on the exchange');
  await refreshPrices(specs);
  for (const s of specs) {
    if (!priceCache.has(s.symbol)) throw new Error(`no public last price for ${s.symbol}`);
  }
  log.ok(`prices: ${specs.map((s) => `${s.symbol}=${priceCache.get(s.symbol)}`).join(' ')}`);

  // 3. fund. FUTURES: deposit USDT to spot then transfer margin to the futures wallet, and set
  // leverage per symbol — no base inventory (positions, not base holdings). SPOT: USDT budget + a
  // small base inventory per unique base for self-cross sells.
  if (IS_FUTURES) {
    for (const acct of accounts) {
      await acct.client.deposit('USDT', FUTURES_MARGIN);
      await acct.client.transfer('SPOT', 'FUTURES', 'USDT', FUTURES_MARGIN);
    }
    for (const acct of accounts) {
      for (const s of specs) await acct.client.setLeverage(s.symbol, LT_LEVERAGE).catch(() => {});
    }
    log.ok(`funded ${accounts.length} accounts (futures margin ${FUTURES_MARGIN} USDT, leverage ${LT_LEVERAGE}x)`);
  } else {
    const baseSpec = new Map<string, SymbolSpec>();
    for (const s of specs) if (!baseSpec.has(s.baseAsset)) baseSpec.set(s.baseAsset, s);
    for (const acct of accounts) {
      await acct.client.deposit('USDT', USDT_FUND);
      for (const [base, s] of baseSpec) {
        const qty = floorQty(s, BASE_FUND_NOTIONAL / priceCache.get(s.symbol)!);
        await acct.client.deposit(base, qty);
      }
    }
    log.ok(`funded ${accounts.length} accounts (USDT ${USDT_FUND} + base ~${BASE_FUND_NOTIONAL} USDT each)`);
  }

  // 4. run: token-bucket pacer with bounded in-flight window.
  const t0 = performance.now();
  const endAt = t0 + LT_DURATION_S * 1000;
  const priceTimer = setInterval(() => void refreshPrices(specs), PRICE_REFRESH_MS);

  let tokens = 0;
  let lastRefill = t0;
  let rr = 0;
  const crossFrac = Math.max(0, Math.min(1, LT_CROSS_PCT / 100));
  const pacer = setInterval(() => {
    if (stopping) return;
    const now = performance.now();
    tokens = Math.min(MAX_INFLIGHT, tokens + ((now - lastRefill) / 1000) * LT_TPS);
    lastRefill = now;
    while (tokens >= 1 && inFlight < MAX_INFLIGHT && !stopping) {
      tokens -= 1;
      inFlight++;
      counters.opsDispatched++;
      const doCross = accounts.length >= 2 && Math.random() < crossFrac;
      const a = accounts[rr % accounts.length]!;
      const b = accounts[(rr + 1) % accounts.length]!;
      rr++;
      const op = doCross ? opCross(a, b, specs) : opPlaceCancel(a, specs);
      void op.catch(() => {}).finally(() => {
        inFlight--;
      });
    }
    if (now >= endAt) void shutdown('duration');
  }, PACER_MS);

  // 5. periodic report.
  let lastReportT = t0;
  let lastOps = 0;
  const reporter = setInterval(() => {
    const now = performance.now();
    const winSec = (now - lastReportT) / 1000 || 1;
    const achieved = (counters.opsDispatched - lastOps) / winSec;
    const p50 = pct(windowSamples, 50);
    const p95 = pct(windowSamples, 95);
    const openOrders = accounts.reduce((n, a) => n + a.ring.length, 0);
    log.info(
      `t=${Math.round((now - t0) / 1000)}s target=${LT_TPS} achieved=${achieved.toFixed(1)} ` +
        `errs=${counters.errs} timeouts=${counters.timeouts} skips=${counters.skips} ` +
        `p50=${p50}ms p95=${p95}ms openOrders=${openOrders} inFlight=${inFlight}`,
    );
    windowSamples = [];
    lastReportT = now;
    lastOps = counters.opsDispatched;
  }, REPORT_MS);

  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(pacer);
    clearInterval(reporter);
    clearInterval(priceTimer);
    log.info(`stopping (${reason}) — draining ${inFlight} in-flight…`);
    for (let w = 0; inFlight > 0 && w < 120; w++) await sleep(100); // ≤12s drain

    // Futures: close tracked net positions first (reversal self-crosses), before sweeping orders.
    for (const acct of accounts) acct.ring = [];
    if (IS_FUTURES) {
      await flattenFutures(accounts, specs).catch(() => {});
      await sleep(500); // let the closing fills settle before the order sweep
    }

    // Cancel every resting order, then poll until the book truly drains. Cancels go through the
    // matching engine asynchronously, so an open-orders read right after cancelAll still shows them
    // in-flight — re-issue cancelAll and re-check for up to ~15s before giving up.
    let remaining = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      for (const acct of accounts) {
        for (const s of specs) await cancelAllFor(acct, s).catch(() => {});
      }
      await sleep(500);
      remaining = 0;
      for (const acct of accounts) {
        for (const s of specs) {
          try {
            remaining += (await acct.client.openOrders(LT_MARKET, s.symbol)).length;
          } catch {
            /* ignore */
          }
        }
      }
      if (remaining === 0) break;
    }
    // best-effort tracked position residual (positions aren't readable via the user surface here).
    const positionsRemaining = IS_FUTURES
      ? Number(
          accounts
            .reduce((n, a) => n + [...a.net.values()].reduce((s, v) => s + Math.abs(v), 0), 0)
            .toFixed(8),
        )
      : 0;

    const elapsedS = (performance.now() - t0) / 1000;
    const summary = {
      startedAt: new Date(Date.now() - elapsedS * 1000).toISOString(),
      endedAt: new Date().toISOString(),
      reason,
      market: LT_MARKET,
      params: {
        market: LT_MARKET,
        accounts: LT_ACCOUNTS,
        targetTps: LT_TPS,
        durationS: LT_DURATION_S,
        symbols: LT_SYMBOLS,
        crossPct: LT_CROSS_PCT,
        leverage: IS_FUTURES ? LT_LEVERAGE : undefined,
        maxInFlight: MAX_INFLIGHT,
      },
      elapsedS: Number(elapsedS.toFixed(1)),
      achievedTps: Number((counters.opsDispatched / elapsedS).toFixed(2)),
      latencyMs: {
        count: allSamples.length,
        p50: pct(allSamples, 50),
        p95: pct(allSamples, 95),
        p99: pct(allSamples, 99),
        max: allSamples.length ? Math.round(Math.max(...allSamples)) : 0,
      },
      errors: { errs: counters.errs, timeouts: counters.timeouts, skips: counters.skips },
      ops: {
        dispatched: counters.opsDispatched,
        completedRequests: counters.completed,
        placeCancel: counters.placeCancel,
        crossLegs: counters.cross,
        ringCancels: counters.cancels,
      },
      openOrdersRemaining: remaining,
      openPositionsRemainingTracked: positionsRemaining,
    };
    const path = `${SUMMARY_DIR}/loadtest-result-${Date.now()}.json`;
    try {
      writeFileSync(path, JSON.stringify(summary, null, 2));
    } catch (e) {
      log.warn(`could not write summary file: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (remaining === 0) log.ok('cleanup verified: 0 open orders');
    else log.warn(`cleanup left ${remaining} open orders`);
    if (IS_FUTURES)
      log.info(`tracked position residual after flatten: ${positionsRemaining} base units`);
    log.ok(`summary → ${path}`);
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  log.ok('load started — Ctrl-C to stop (cancels all orders).');
}

/** integer-percentile of a sample array (ms, rounded). Empty → 0. */
function pct(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[i]!);
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
