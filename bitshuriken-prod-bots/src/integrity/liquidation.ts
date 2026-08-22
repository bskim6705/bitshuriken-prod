import { config } from '../config';
import { rows, type CheckResult, type Status } from './db';

// F2 — liquidation oracle. "A real exchange would liquidate this, but it's still NORMAL" (and the
// reverse). Point-in-time: recompute each ISOLATED position's margin ratio from the live mark price
// and the symbol's maintenance-margin rate, and compare against its status. Cross-margin is
// account-level (not per-position), so those are counted but not asserted here.

interface PositionRow {
  userId: string;
  tickerSymbol: string;
  qty: string;
  entryPrice: string;
  isolatedMargin: string;
  marginMode: string;
  status: string;
  mmr: string | null;
}

async function markOf(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`${config.api.futures}/futures/market/mark-price?symbol=${symbol}`);
    if (!res.ok) return null;
    const env = (await res.json()) as { data?: { markPrice: string | null } };
    const m = env.data?.markPrice;
    return m == null ? null : Number(m);
  } catch {
    return null;
  }
}

export async function liquidationOracle(): Promise<CheckResult> {
  const positions = await rows<PositionRow>(
    `SELECT p."userId", p."tickerSymbol", p.qty, p."entryPrice", p."isolatedMargin",
            p."marginMode", p.status, c.mmr
       FROM "Position" p
       LEFT JOIN "FuturesConfig" c ON c."tickerSymbol" = p."tickerSymbol"
      WHERE p."tickerMarket"='FUTURES' AND ABS(p.qty) > 1e-8`,
  );
  if (positions.length === 0) {
    return { name: 'F2 liquidation oracle', status: 'pass', detail: 'no open futures positions' };
  }

  const symbols = [...new Set(positions.map((p) => p.tickerSymbol))];
  const marks = new Map<string, number | null>();
  await Promise.all(symbols.map(async (s) => marks.set(s, await markOf(s))));

  const shouldLiq: string[] = []; // NORMAL but underwater — liquidation missed (fail)
  const marginal: string[] = []; // NORMAL but at/under maintenance this tick (warn — may be mid-liq)
  let crossSkipped = 0;
  let noMark = 0;

  for (const p of positions) {
    if (p.marginMode === 'CROSS') {
      crossSkipped++;
      continue;
    }
    const mark = marks.get(p.tickerSymbol);
    if (mark == null || p.mmr == null) {
      noMark++;
      continue;
    }
    const qty = Number(p.qty);
    const uPnl = (mark - Number(p.entryPrice)) * qty;
    const equity = Number(p.isolatedMargin) + uPnl;
    const maint = Number(p.mmr) * Math.abs(qty) * mark;
    const tag = `${p.userId} ${p.tickerSymbol} qty=${qty} equity=${equity.toFixed(2)} maint=${maint.toFixed(2)} status=${p.status}`;

    if (p.status === 'NORMAL') {
      if (equity <= 0) shouldLiq.push(`${tag} (BANKRUPT, still NORMAL)`);
      else if (equity <= maint) marginal.push(tag);
    }
    // status === 'LIQUIDATING' comfortably healthy → possible wrongful liquidation (transient; warn)
    if (p.status === 'LIQUIDATING' && equity > maint * 2) {
      marginal.push(`${tag} (LIQUIDATING but healthy)`);
    }
  }

  const status: Status = shouldLiq.length ? 'fail' : marginal.length ? 'warn' : 'pass';
  const parts = [`${positions.length} positions`];
  if (crossSkipped) parts.push(`${crossSkipped} cross (acct-level, skipped)`);
  if (noMark) parts.push(`${noMark} no mark/mmr`);
  return {
    name: 'F2 liquidation oracle',
    status,
    detail: shouldLiq.length
      ? `${shouldLiq.length} underwater position(s) still NORMAL — liquidation missed`
      : marginal.length
        ? `${marginal.length} position(s) at maintenance this tick (transient?)`
        : `all isolated positions correctly classified (${parts.join(', ')})`,
    samples: [...shouldLiq, ...marginal].slice(0, 6),
  };
}
