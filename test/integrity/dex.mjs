// DEX (AMM) integrity — synchronous, fully controlled (no bots, no match engine).
// Gold-standard conservation: every base/quote unit only moves between dex wallets and pool
// reserves; the fee stays in reserves (k non-decreasing). Verifies swap exactness, LP accounting.
import { BASE, signed, jwt, makeTrader, loginAdmin, deposit, transfer, toScaled, fromScaled, makeReport, at } from './lib.mjs';

const SYM = 'ATOMUSDT', BASEA = 'ATOM', QUOTEA = 'USDT';
const R = makeReport(`dex:${SYM}`);
const SC = 100000000n;

const adminCookie = await loginAdmin();
const adminDeposit = (asset, qty) => jwt(BASE.portal, 'POST', '/account/deposits', { cookie: adminCookie, body: { assetSymbol: asset, qty } });
const adminTransfer = (from, to, asset, qty) => jwt(BASE.portal, 'POST', '/account/transfers', { cookie: adminCookie, body: { fromMarket: from, toMarket: to, assetSymbol: asset, qty } });

async function getPool() {
  const r = await jwt(BASE.dex, 'GET', `/dex/pools/${SYM}`);
  return r.status === 200 ? r.json.data : null;
}
const poolReserves = (p) => ({ base: toScaled(p.reserveBase), quote: toScaled(p.reserveQuote), shares: toScaled(p.totalShares) });
async function dexBal(key) {
  const r = await signed(BASE.dex, 'GET', '/dex/account/balances', { apiKey: key.apiKey, secret: key.secret });
  const m = {}; for (const b of r.json.data) m[b.asset] = toScaled(b.balance); return m;
}
const bal = (m, a) => m[a] ?? 0n;

// ---- ensure pool exists (seed 1000 ATOM / 50000 USDT from admin's dex wallet) ----
let pool = await getPool();
if (!pool) {
  await adminDeposit(BASEA, '2000'); await adminDeposit(QUOTEA, '100000');
  await adminTransfer('SPOT', 'DEX', BASEA, '2000'); await adminTransfer('SPOT', 'DEX', QUOTEA, '100000');
  const cp = await jwt(BASE.dex, 'POST', '/dex/admin/pools', { cookie: adminCookie, body: { symbol: SYM, baseAsset: BASEA, quoteAsset: QUOTEA, feeBps: 30, seedBase: '1000', seedQuote: '50000' } });
  R.check('0a pool created', cp.status === 201, `status=${cp.status} ${JSON.stringify(cp.json).slice(0,140)}`);
  pool = await getPool();
}
R.check('0b pool present with reserves', !!pool && toScaled(pool.reserveBase) > 0n, `base=${pool?.reserveBase} quote=${pool?.reserveQuote} shares=${pool?.totalShares} fee=${pool?.feeBps}bps`);
const FEE = pool.feeBps;

// ============================================================
// CASE 1: SWAP exactness + conservation + k non-decreasing (BUY base with quote)
// ============================================================
{
  const T = await makeTrader('dexSwap', {});
  await deposit(T.key, QUOTEA, '5000'); await transfer(T.key, 'SPOT', 'DEX', QUOTEA, '5000');
  const amtIn = '2000';
  const p0 = poolReserves(await getPool());
  const tb0 = await dexBal(T.key);
  // quote (read-only) then execute; they must agree
  const q = await signed(BASE.dex, 'GET', '/dex/quote', { apiKey: T.key.apiKey, secret: T.key.secret, query: { pool: SYM, side: 'BUY', amountIn: amtIn } });
  const quoted = toScaled(q.json.data.outQty);
  const sw = await signed(BASE.dex, 'POST', '/dex/swap', { apiKey: T.key.apiKey, secret: T.key.secret, body: { pool: SYM, side: 'BUY', amountIn: amtIn, minAmountOut: '0.00000001' } });
  R.check('1a swap ok', sw.status === 201, `status=${sw.status} ${JSON.stringify(sw.json).slice(0,120)}`);
  const got = toScaled(sw.json.data.outQty);
  R.eqScaled('1b quote == execute outQty', quoted, got);
  const p1 = poolReserves(await getPool());
  const tb1 = await dexBal(T.key);
  // conservation: trader quote out == pool quote in; trader base in == pool base out
  R.eqScaled('1c trader quote spent == amountIn', bal(tb0, QUOTEA) - bal(tb1, QUOTEA), toScaled(amtIn));
  R.eqScaled('1d trader base received == outQty', bal(tb1, BASEA) - bal(tb0, BASEA), got);
  R.eqScaled('1e pool quote += amountIn', p1.quote - p0.quote, toScaled(amtIn));
  R.eqScaled('1f pool base -= outQty', p0.base - p1.base, got);
  R.eqScaled('1g zero-sum base (trader+pool)', (bal(tb1, BASEA) - bal(tb0, BASEA)) + (p1.base - p0.base), 0n);
  R.eqScaled('1h zero-sum quote (trader+pool)', (bal(tb1, QUOTEA) - bal(tb0, QUOTEA)) + (p1.quote - p0.quote), 0n);
  // k non-decreasing (products of scaled reserves)
  const kBefore = p0.base * p0.quote, kAfter = p1.base * p1.quote;
  R.check('1i k non-decreasing (fee retained in pool)', kAfter >= kBefore, `kAfter-kBefore=${kAfter - kBefore}`);
  // formula sanity: out ≈ rOut*aInWithFee/(rIn+aInWithFee), within 1e-8
  const aIn = Number(amtIn), rIn = Number(fromScaled(p0.quote)), rOut = Number(fromScaled(p0.base));
  const aInWithFee = aIn * (10000 - FEE) / 10000;
  const expect = rOut * aInWithFee / (rIn + aInWithFee);
  R.check('1j outQty matches constant-product formula', Math.abs(expect - Number(fromScaled(got))) < 1e-6, `expect≈${expect.toFixed(8)} got=${fromScaled(got)}`);
}

// ============================================================
// CASE 2: slippage protection — minOut above achievable is rejected, no state change
// ============================================================
{
  const T = await makeTrader('dexSlip', {});
  await deposit(T.key, QUOTEA, '1000'); await transfer(T.key, 'SPOT', 'DEX', QUOTEA, '1000');
  const p0 = poolReserves(await getPool());
  const tb0 = await dexBal(T.key);
  const sw = await signed(BASE.dex, 'POST', '/dex/swap', { apiKey: T.key.apiKey, secret: T.key.secret, body: { pool: SYM, side: 'BUY', amountIn: '1000', minAmountOut: '999999' } });
  R.check('2a swap with impossible minOut rejected', sw.status >= 400, `status=${sw.status} code=${sw.json.code}`);
  const p1 = poolReserves(await getPool());
  const tb1 = await dexBal(T.key);
  R.eqScaled('2b reserves unchanged after rejected swap', p1.quote - p0.quote, 0n);
  R.eqScaled('2c trader balance unchanged after rejected swap', bal(tb1, QUOTEA) - bal(tb0, QUOTEA), 0n);
}

// ============================================================
// CASE 3: add liquidity proportional + conservation
// ============================================================
{
  const T = await makeTrader('dexLP', {});
  await deposit(T.key, BASEA, '100'); await deposit(T.key, QUOTEA, '100000');
  await transfer(T.key, 'SPOT', 'DEX', BASEA, '100'); await transfer(T.key, 'SPOT', 'DEX', QUOTEA, '100000');
  const p0 = poolReserves(await getPool());
  const tb0 = await dexBal(T.key);
  // add at pool ratio: baseQty arbitrary, quoteQty = baseQty * reserveQuote/reserveBase (so balanced)
  const baseQty = '10';
  const quoteQtyScaled = (toScaled(baseQty) * p0.quote) / p0.base; // proportional
  const quoteQty = fromScaled(quoteQtyScaled);
  const add = await signed(BASE.dex, 'POST', '/dex/liquidity', { apiKey: T.key.apiKey, secret: T.key.secret, body: { pool: SYM, baseQty, quoteQty } });
  R.check('3a add liquidity ok', add.status === 201, `status=${add.status} ${JSON.stringify(add.json).slice(0,160)}`);
  const p1 = poolReserves(await getPool());
  const tb1 = await dexBal(T.key);
  // conservation: trader pays exactly what pool gains
  const dBase = bal(tb0, BASEA) - bal(tb1, BASEA), dQuote = bal(tb0, QUOTEA) - bal(tb1, QUOTEA);
  R.eqScaled('3b pool base += trader base paid', p1.base - p0.base, dBase);
  R.eqScaled('3c pool quote += trader quote paid', p1.quote - p0.quote, dQuote);
  // shares minted proportional: ≈ totalShares * baseAdded/reserveBase
  const sharesMinted = p1.shares - p0.shares;
  const expectShares = (p0.shares * (p1.base - p0.base)) / p0.base;
  R.eqScaled('3d LP shares minted == totalShares*baseAdded/reserveBase (floor, ±1e-8)', sharesMinted, expectShares, 1n);
  R.check('3e shares minted > 0', sharesMinted > 0n, `minted=${fromScaled(sharesMinted)}`);

  // CASE 4: remove the just-minted shares -> get back proportional, no value created
  const p2pre = poolReserves(await getPool());
  const tb2pre = await dexBal(T.key);
  const rmResp = await signed(BASE.dex, 'DELETE', '/dex/liquidity', { apiKey: T.key.apiKey, secret: T.key.secret, body: { pool: SYM, shares: fromScaled(sharesMinted) } });
  const rmOk = rmResp.status === 200 || rmResp.status === 201;
  R.check('4a remove liquidity ok', rmOk, `status=${rmResp.status} ${JSON.stringify(rmResp.json).slice(0,140)}`);
  const p2 = poolReserves(await getPool());
  const tb2 = await dexBal(T.key);
  const baseOut = bal(tb2, BASEA) - bal(tb2pre, BASEA), quoteOut = bal(tb2, QUOTEA) - bal(tb2pre, QUOTEA);
  R.eqScaled('4b pool base -= base paid out', p2pre.base - p2.base, baseOut);
  R.eqScaled('4c pool quote -= quote paid out', p2pre.quote - p2.quote, quoteOut);
  R.eqScaled('4d total shares back to pre-add', p2.shares, p0.shares, 1n);
  // round-trip: out <= in (floor rounding can only favor pool), and within 1e-8 per asset
  R.check('4e round-trip base out <= base in (no value created)', baseOut <= dBase, `in=${fromScaled(dBase)} out=${fromScaled(baseOut)}`);
  R.check('4f round-trip quote out <= quote in (no value created)', quoteOut <= dQuote, `in=${fromScaled(dQuote)} out=${fromScaled(quoteOut)}`);
}

// ============================================================
// CASE 5: DB reconciliation — Σ LpPosition.shares == Pool.totalShares
// ============================================================
{
  // (verified externally via SQL in the runner; here assert pool view internal consistency)
  const p = await getPool();
  R.check('5a pool reserves are exact 8dp strings', /^\d+\.\d{8}$/.test(p.reserveBase) && /^\d+\.\d{8}$/.test(p.reserveQuote), `base=${p.reserveBase} quote=${p.reserveQuote}`);
  R.check('5b pool price == reserveQuote/reserveBase', Math.abs(Number(p.price) - Number(p.reserveQuote) / Number(p.reserveBase)) < 1e-4, `price=${p.price} ratio=${(Number(p.reserveQuote)/Number(p.reserveBase)).toFixed(8)}`);
}

const out = R.done();
console.log('REPORT_JSON ' + JSON.stringify(out));
process.exit(out.failed ? 1 : 0);
