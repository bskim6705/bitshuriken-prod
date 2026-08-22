import { rows, type CheckResult, type Status } from './db';

// F1/F4 monetary invariants — "things a real exchange would never let happen to money."
// Read Postgres directly (cross-user totals have no REST endpoint). Bots are users, so the
// checker only READS the DB; it never mutates through anything but the public order path.

/** F1a: no wallet may hold a negative free or locked balance (money created / frozen gone wrong). */
export async function nonNegativeBalances(): Promise<CheckResult> {
  const bad = await rows(
    `SELECT "userId","assetSymbol","marketType",balance,locked
       FROM "Wallet" WHERE balance < 0 OR locked < 0`,
  );
  return {
    name: 'F1a non-negative balances',
    status: bad.length ? 'fail' : 'pass',
    detail: bad.length ? `${bad.length} wallet(s) with negative balance/locked` : 'all wallets ≥ 0',
    samples: bad.slice(0, 5).map((r) => `${r.userId} ${r.assetSymbol}/${r.marketType} bal=${r.balance} locked=${r.locked}`),
  };
}

/**
 * F1b (the big one): every SPOT wallet's total holdings (balance+locked) must equal what the
 * ledgers say it should be — funding flows + realized trade effects − commissions. A drift is a
 * settlement bug (the classic signature: double-settlement leaves a wallet off by a trade's worth).
 * FundingTx contributes +qty when toMarket=SPOT and −qty when fromMarket=SPOT (uniform across
 * deposit/withdrawal/transfer/adjustment/subaccount). Small residual (per-fill 8dp rounding) warns;
 * a gross mismatch fails.
 */
export async function spotLedgerReconciliation(): Promise<CheckResult> {
  const bad = await rows<{ userId: string; assetSymbol: string; held: string; exp: string }>(
    `WITH t AS (
        SELECT tr."makerUserId", tr."takerUserId", tr."takerSide", tr.qty, tr.price,
               tr."makerCommission", tr."makerCommissionAsset",
               tr."takerCommission", tr."takerCommissionAsset",
               tk."baseAssetSymbol" AS base, tk."quoteAssetSymbol" AS quote
          FROM "Trade" tr
          JOIN "Ticker" tk ON tk.symbol = tr."tickerSymbol" AND tk."marketType" = tr."tickerMarket"
         WHERE tr."tickerMarket" = 'SPOT'
     ), legs AS (
        SELECT "takerUserId" AS uid, base  AS asset, CASE WHEN "takerSide"='BUY' THEN qty ELSE -qty END AS d FROM t
        UNION ALL SELECT "takerUserId", quote, CASE WHEN "takerSide"='BUY' THEN -ROUND(price*qty,8) ELSE ROUND(price*qty,8) END FROM t
        UNION ALL SELECT "takerUserId", "takerCommissionAsset", -"takerCommission" FROM t WHERE "takerCommissionAsset" IS NOT NULL
        UNION ALL SELECT "makerUserId", base, CASE WHEN "takerSide"='BUY' THEN -qty ELSE qty END FROM t
        UNION ALL SELECT "makerUserId", quote, CASE WHEN "takerSide"='BUY' THEN ROUND(price*qty,8) ELSE -ROUND(price*qty,8) END FROM t
        UNION ALL SELECT "makerUserId", "makerCommissionAsset", -"makerCommission" FROM t WHERE "makerCommissionAsset" IS NOT NULL
     ), trade_agg AS (SELECT uid, asset, SUM(d) AS d FROM legs GROUP BY uid, asset),
        funding AS (
          SELECT "userId" AS uid, "assetSymbol" AS asset,
                 SUM((CASE WHEN "toMarket"='SPOT' THEN qty ELSE 0 END)
                   - (CASE WHEN "fromMarket"='SPOT' THEN qty ELSE 0 END)) AS d
            FROM "FundingTx" GROUP BY "userId","assetSymbol"
        ),
        expected AS (
          SELECT COALESCE(a.uid,f.uid) AS uid, COALESCE(a.asset,f.asset) AS asset,
                 COALESCE(a.d,0)+COALESCE(f.d,0) AS exp
            FROM trade_agg a FULL OUTER JOIN funding f ON f.uid=a.uid AND f.asset=a.asset
        )
     SELECT w."userId", w."assetSymbol", (w.balance+w.locked) AS held, COALESCE(e.exp,0) AS exp
       FROM "Wallet" w
       LEFT JOIN expected e ON e.uid = w."userId" AND e.asset = w."assetSymbol"
      WHERE w."marketType" = 'SPOT'
        AND ABS((w.balance+w.locked) - COALESCE(e.exp,0)) > 1e-6`,
  );
  const egregious = bad.filter((r) => Math.abs(Number(r.held) - Number(r.exp)) > 0.01);
  const status: Status = egregious.length ? 'fail' : bad.length ? 'warn' : 'pass';
  return {
    name: 'F1b spot wallet == funding + trade ledger',
    status,
    detail: bad.length
      ? `${bad.length} (user,asset) ledger mismatch${egregious.length ? `, ${egregious.length} gross (>0.01)` : ' (rounding residual)'}`
      : 'every spot wallet reconciles to its ledger',
    samples: (egregious.length ? egregious : bad)
      .slice(0, 6)
      .map((r) => `${r.userId} ${r.assetSymbol} held=${r.held} expected=${Number(r.exp).toFixed(8)} Δ=${(Number(r.held) - Number(r.exp)).toFixed(8)}`),
  };
}

/** INV-2 (supports F1): executedQty of every order equals the sum of its trade legs, and ≤ origQty. */
export async function fillAccounting(): Promise<CheckResult> {
  const mismatched = await rows(
    `WITH legs AS (
        SELECT "makerOrderId" AS oid, qty FROM "Trade"
        UNION ALL SELECT "takerOrderId", qty FROM "Trade"
     ), per AS (SELECT oid, SUM(qty) AS q FROM legs GROUP BY oid)
     SELECT o.id, o."executedQty", COALESCE(p.q,0) AS filled
       FROM "Order" o LEFT JOIN per p ON p.oid = o.id
      WHERE ABS(o."executedQty" - COALESCE(p.q,0)) > 1e-6`,
  );
  const over = await rows(
    `SELECT id,"origQty","executedQty" FROM "Order"
      WHERE "origQty" IS NOT NULL AND "executedQty" > "origQty" + 1e-8`,
  );
  const fail = mismatched.length + over.length;
  return {
    name: 'F1c fill accounting (executedQty = Σ trades, ≤ origQty)',
    status: fail ? 'fail' : 'pass',
    detail: fail
      ? `${mismatched.length} executedQty≠Σfills, ${over.length} executedQty>origQty`
      : 'every order matches its trade legs',
    samples: [
      ...mismatched.slice(0, 4).map((r) => `${r.id} exec=${r.executedQty} fills=${r.filled}`),
      ...over.slice(0, 2).map((r) => `${r.id} exec=${r.executedQty} > orig=${r.origQty}`),
    ],
  };
}

/**
 * F4: locked funds must be released. A SPOT wallet's locked equals the sum of remaining locks
 * across the user's open LIMIT/POST_ONLY orders + the user's EXECUTING OCO list locks. A
 * terminal order whose lock was not released shows up as locked > Σ open-order locks → fail.
 */
export async function spotLockAccounting(): Promise<CheckResult> {
  const bad = await rows<{ userId: string; assetSymbol: string; locked: string; exp: string }>(
    `WITH oo AS (
        SELECT o."userId", o.side, o.price, (o."origQty" - o."executedQty") AS rem,
               t."baseAssetSymbol" AS base, t."quoteAssetSymbol" AS quote
          FROM "Order" o
          JOIN "Ticker" t ON t.symbol = o."tickerSymbol" AND t."marketType" = o."tickerMarket"
         WHERE o."tickerMarket" = 'SPOT'
           AND o.status IN ('NEW','OPEN','PARTIAL')
           AND o.type IN ('LIMIT','POST_ONLY')
           AND o."orderListId" IS NULL
           AND o.price IS NOT NULL AND o."origQty" IS NOT NULL
     ), order_lock AS (
        SELECT "userId", CASE WHEN side='BUY' THEN quote ELSE base END AS asset,
               SUM(CASE WHEN side='BUY' THEN price*rem ELSE rem END) AS lk
          FROM oo GROUP BY "userId", CASE WHEN side='BUY' THEN quote ELSE base END
     ), list_lock AS (
        SELECT "userId", "lockAssetSymbol" AS asset, SUM("lockAmount") AS lk
          FROM "OrderList" WHERE status = 'EXECUTING' AND "tickerMarket" = 'SPOT'
         GROUP BY "userId", "lockAssetSymbol"
     ), expected AS (
        SELECT COALESCE(o."userId",l."userId") AS uid, COALESCE(o.asset,l.asset) AS asset,
               COALESCE(o.lk,0)+COALESCE(l.lk,0) AS lk
          FROM order_lock o FULL OUTER JOIN list_lock l ON l."userId"=o."userId" AND l.asset=o.asset
     )
     SELECT w."userId", w."assetSymbol", w.locked, COALESCE(e.lk,0) AS exp
       FROM "Wallet" w
       LEFT JOIN expected e ON e.uid = w."userId" AND e.asset = w."assetSymbol"
      WHERE w."marketType" = 'SPOT'
        AND ABS(w.locked - COALESCE(e.lk,0)) > 1e-6`,
  );
  const egregious = bad.filter((r) => Math.abs(Number(r.locked) - Number(r.exp)) > 1);
  const status: Status = egregious.length ? 'fail' : bad.length ? 'warn' : 'pass';
  return {
    name: 'F4 spot locked = Σ open-order + OCO locks',
    status,
    detail: bad.length
      ? `${bad.length} (user,asset) lock mismatch${egregious.length ? `, ${egregious.length} > 1.0 (frozen leak)` : ''}`
      : 'locked balances match resting orders',
    samples: bad.slice(0, 6).map((r) => `${r.userId} ${r.assetSymbol} locked=${r.locked} expected=${Number(r.exp).toFixed(8)}`),
  };
}

export async function runInvariants(): Promise<CheckResult[]> {
  return [
    await nonNegativeBalances(),
    await spotLedgerReconciliation(),
    await fillAccounting(),
    await spotLockAccounting(),
  ];
}
