import { rows, type CheckResult, type Status } from './db';

// F3 — futures PnL / ledger consistency. Money-only, no mark price needed:
// balance + locked + Σ isolatedMargin == Σ FuturesIncome  (derivation: opening margin is a
// wallet→position move, not income; every realized flow — transfer, RPNL, commission, funding,
// liquidation fee, insurance clear — is a FuturesIncome row; uPnL is unrealized so it drops out).

export async function futuresLedgerReconciliation(): Promise<CheckResult> {
  const bad = await rows<{ uid: string; w: string; m: string; i: string }>(
    `WITH ids AS (
        SELECT DISTINCT "userId" AS uid FROM "FuturesIncome"
        UNION SELECT "userId" FROM "Wallet" WHERE "marketType"='FUTURES'
        UNION SELECT "userId" FROM "Position" WHERE "tickerMarket"='FUTURES'
     )
     SELECT id.uid,
       COALESCE((SELECT balance+locked FROM "Wallet" w
                  WHERE w."userId"=id.uid AND w."marketType"='FUTURES' AND w."assetSymbol"='USDT'),0) AS w,
       COALESCE((SELECT SUM("isolatedMargin") FROM "Position" p
                  WHERE p."userId"=id.uid AND p."tickerMarket"='FUTURES'),0) AS m,
       COALESCE((SELECT SUM(income) FROM "FuturesIncome" fi WHERE fi."userId"=id.uid),0) AS i
       FROM ids id`,
  );
  const mismatched = bad.filter((r) => Math.abs(Number(r.w) + Number(r.m) - Number(r.i)) > 1e-6);
  const egregious = mismatched.filter((r) => Math.abs(Number(r.w) + Number(r.m) - Number(r.i)) > 0.01);
  const status: Status = egregious.length ? 'fail' : mismatched.length ? 'warn' : 'pass';
  return {
    name: 'F3a futures wallet + margin == Σ FuturesIncome',
    status,
    detail: mismatched.length
      ? `${mismatched.length} account(s) off-ledger${egregious.length ? `, ${egregious.length} gross (>0.01)` : ' (rounding)'}`
      : 'every futures account reconciles to its income ledger',
    samples: (egregious.length ? egregious : mismatched)
      .slice(0, 6)
      .map((r) => `${r.uid} wallet=${Number(r.w).toFixed(8)} margin=${Number(r.m).toFixed(8)} Σincome=${Number(r.i).toFixed(8)} Δ=${(Number(r.w) + Number(r.m) - Number(r.i)).toFixed(8)}`),
  };
}

/** F3b: realized PnL and funding are zero-sum across all accounts (incl. insurance fund). */
export async function futuresZeroSum(): Promise<CheckResult> {
  const r = await rows<{ rpnl: string; funding: string }>(
    `SELECT
        COALESCE(SUM(income) FILTER (WHERE "incomeType"='REALIZED_PNL'),0) AS rpnl,
        COALESCE(SUM(income) FILTER (WHERE "incomeType"='FUNDING_FEE'),0) AS funding
      FROM "FuturesIncome"`,
  );
  const rpnl = Number(r[0]?.rpnl ?? 0);
  const funding = Number(r[0]?.funding ?? 0);
  const bad = Math.abs(rpnl) > 0.01 || Math.abs(funding) > 0.01;
  const warn = !bad && (Math.abs(rpnl) > 1e-6 || Math.abs(funding) > 1e-6);
  return {
    name: 'F3b realized PnL & funding zero-sum',
    status: bad ? 'fail' : warn ? 'warn' : 'pass',
    detail: `Σ RPNL=${rpnl.toFixed(8)}, Σ funding=${funding.toFixed(8)}`,
  };
}

/** F3c: per-symbol Σ position.qty == 0 (every long matched by a short; ADR-031/032). */
export async function futuresPositionParity(): Promise<CheckResult> {
  const bad = await rows<{ tickerSymbol: string; net: string }>(
    `SELECT "tickerSymbol", SUM(qty) AS net FROM "Position"
      WHERE "tickerMarket"='FUTURES'
      GROUP BY "tickerSymbol" HAVING ABS(SUM(qty)) > 1e-8`,
  );
  return {
    name: 'F3c per-symbol Σ position.qty == 0',
    status: bad.length ? 'fail' : 'pass',
    detail: bad.length ? `${bad.length} symbol(s) with net position ≠ 0` : 'positions net to zero per symbol',
    samples: bad.slice(0, 6).map((r) => `${r.tickerSymbol} net=${r.net}`),
  };
}

export async function runFutures(): Promise<CheckResult[]> {
  return [
    await futuresLedgerReconciliation(),
    await futuresZeroSum(),
    await futuresPositionParity(),
  ];
}
