import type { SubaccountClient } from '../core/exchange';
import type { AccountTrade, Balance, Market } from '../core/types';

/**
 * Agent integrity: does the exchange's own trade ledger explain the agent's balances,
 * and is the agent operationally healthy? An isolated subaccount starts with a known
 * USDT capital and only trades one symbol — so replaying /account/trades from that
 * capital must reconstruct the live /account/balances. Drift = a real accounting bug.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface Reconciliation {
  quoteAsset: string;
  baseAsset: string;
  initialQuote: number;
  expectedQuote: number; // ledger-reconstructed
  expectedBase: number;
  actualQuote: number; // live balances (free + locked)
  actualBase: number;
  quoteDrift: number; // actual - expected
  baseDrift: number;
  tradeCount: number;
  truncated: boolean; // ledger paging hit the cap (recon may be incomplete)
}

export interface IntegrityHealth {
  running: boolean;
  consecutiveErrors: number;
  lastError: string | null;
  lastBarTime: number | null;
  barStalenessMs: number | null;
  barFresh: boolean;
  equityUsdt: number;
  positionQty: number;
}

export interface IntegrityReport {
  agentId: string;
  label: string;
  strategyId: string;
  symbol: string;
  agentStatus: string;
  status: CheckStatus; // worst of all checks
  checks: Check[];
  reconciliation: Reconciliation;
  health: IntegrityHealth;
  checkedAt: number;
}

export interface HealthInput {
  running: boolean;
  consecutiveErrors: number;
  lastError: string | null;
  lastBarTime: number | null;
  intervalMs: number;
  now: number;
  equityUsdt: number;
  positionQty: number;
}

const PAGE = 1000;
const MAX_PAGES = 50; // 50k trades cap — beyond this the recon is flagged truncated

/** interval string → milliseconds (e.g. "1m"→60000, "1h"→3600000). */
export function intervalToMs(interval: string): number {
  const m = /^(\d+)([mhdw])$/.exec(interval.trim());
  if (!m) return 60_000;
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as 'm' | 'h' | 'd' | 'w'];
  return n * unit;
}

/** Full trade history for `symbol`, paged newest→oldest until exhausted (deduped, chronological). */
export async function allTrades(
  client: SubaccountClient,
  market: Market,
  symbol: string,
): Promise<{ trades: AccountTrade[]; truncated: boolean }> {
  const acc: AccountTrade[] = [];
  let endTime: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await client.trades(market, { symbol, limit: PAGE, endTime });
    if (batch.length === 0) return { trades: dedup(acc), truncated: false };
    acc.push(...batch);
    if (batch.length < PAGE) return { trades: dedup(acc), truncated: false };
    endTime = Math.min(...batch.map((t) => t.time)) - 1; // strictly older next page
  }
  return { trades: dedup(acc), truncated: true };
}

function dedup(trades: AccountTrade[]): AccountTrade[] {
  const seen = new Set<string>();
  const out: AccountTrade[] = [];
  for (const t of trades) if (!seen.has(t.id)) (seen.add(t.id), out.push(t));
  return out.sort((a, b) => a.time - b.time);
}

/** Reconstruct expected balances from the ledger and compare to live balances. */
export function reconcile(
  initialCapital: number,
  quoteAsset: string,
  baseAsset: string,
  trades: AccountTrade[],
  balances: Balance[],
  truncated: boolean,
): Reconciliation {
  let quote = initialCapital;
  let base = 0;
  for (const t of trades) {
    const qty = Number(t.qty);
    const quoteQty = Number(t.quoteQty) || Number(t.price) * qty;
    if (t.isBuyer) (base += qty), (quote -= quoteQty);
    else (base -= qty), (quote += quoteQty);
    const commission = Number(t.commission);
    if (t.commissionAsset === quoteAsset) quote -= commission;
    else if (t.commissionAsset === baseAsset) base -= commission;
    // commission in a third asset is not modeled — would surface as drift
  }
  const held = (asset: string): number =>
    balances.filter((b) => b.asset === asset).reduce((s, b) => s + Number(b.free) + Number(b.locked), 0);
  const actualQuote = held(quoteAsset);
  const actualBase = held(baseAsset);
  return {
    quoteAsset,
    baseAsset,
    initialQuote: initialCapital,
    expectedQuote: quote,
    expectedBase: base,
    actualQuote,
    actualBase,
    quoteDrift: actualQuote - quote,
    baseDrift: actualBase - base,
    tradeCount: trades.length,
    truncated,
  };
}

const worst = (a: CheckStatus, b: CheckStatus): CheckStatus =>
  a === 'fail' || b === 'fail' ? 'fail' : a === 'warn' || b === 'warn' ? 'warn' : 'pass';

const within = (drift: number, tol: number): CheckStatus =>
  Math.abs(drift) <= tol ? 'pass' : Math.abs(drift) <= tol * 10 ? 'warn' : 'fail';

/** Assemble the integrity report: ledger↔balance reconciliation + operational health. */
export function buildIntegrity(
  meta: { agentId: string; label: string; strategyId: string; symbol: string; agentStatus: string },
  h: HealthInput,
  recon: Reconciliation,
  tol: { quote: number; base: number },
): IntegrityReport {
  const checks: Check[] = [];

  checks.push({
    name: `ledger↔balance (${recon.quoteAsset})`,
    status: within(recon.quoteDrift, tol.quote),
    detail: `expected ${recon.expectedQuote.toFixed(8)}, actual ${recon.actualQuote.toFixed(8)} — drift ${recon.quoteDrift.toFixed(8)}`,
  });
  checks.push({
    name: `ledger↔balance (${recon.baseAsset})`,
    status: within(recon.baseDrift, tol.base),
    detail: `expected ${recon.expectedBase.toFixed(8)}, actual ${recon.actualBase.toFixed(8)} — drift ${recon.baseDrift.toFixed(8)}`,
  });
  if (recon.truncated)
    checks.push({ name: 'ledger completeness', status: 'warn', detail: `trade history capped at ${recon.tradeCount} — reconciliation may be incomplete` });

  const barStalenessMs = h.lastBarTime === null ? null : h.now - h.lastBarTime;
  const barFresh = barStalenessMs !== null && barStalenessMs <= 3 * h.intervalMs;
  if (h.running) {
    const barStatus: CheckStatus = h.lastBarTime === null ? 'warn' : barFresh ? 'pass' : 'fail';
    checks.push({
      name: 'bar freshness',
      status: barStatus,
      detail:
        h.lastBarTime === null
          ? 'no bar processed yet'
          : `last bar ${Math.round((barStalenessMs ?? 0) / 1000)}s ago (interval ${Math.round(h.intervalMs / 1000)}s)`,
    });
  }

  const errStatus: CheckStatus = h.consecutiveErrors >= 3 ? 'fail' : h.consecutiveErrors > 0 ? 'warn' : 'pass';
  checks.push({
    name: 'execution health',
    status: h.running ? errStatus : 'warn',
    detail: h.running
      ? `${h.consecutiveErrors} consecutive error(s)${h.lastError ? ` — ${h.lastError}` : ''}`
      : 'agent stopped',
  });

  const equitySane = Number.isFinite(h.equityUsdt) && h.equityUsdt >= 0 && Number.isFinite(h.positionQty);
  checks.push({
    name: 'equity sanity',
    status: equitySane ? 'pass' : 'fail',
    detail: `equity ${h.equityUsdt.toFixed(2)} ${recon.quoteAsset}, position ${h.positionQty.toFixed(8)} ${recon.baseAsset}`,
  });

  return {
    ...meta,
    status: checks.reduce<CheckStatus>((s, c) => worst(s, c.status), 'pass'),
    checks,
    reconciliation: recon,
    health: {
      running: h.running,
      consecutiveErrors: h.consecutiveErrors,
      lastError: h.lastError,
      lastBarTime: h.lastBarTime,
      barStalenessMs,
      barFresh,
      equityUsdt: h.equityUsdt,
      positionQty: h.positionQty,
    },
    checkedAt: h.now,
  };
}
