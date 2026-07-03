// FUTURES integrity — live pipeline on BTCUSDT. The futures book is empty (futures bots idle),
// so two test users cross ONLY each other: A goes LONG, B goes SHORT, then both close.
// Verifies: ledger conservation (at flat, wallet == Σ FuturesIncome), PnL zero-sum (A+B==0),
// margin reserve = ceil8(notional/leverage), leverage bounds, insufficient-margin rejection.
// Funding (cron 00/08/16 UTC) is out of session scope.
import { BASE, signed, jwt, makeTrader, deposit, transfer, toScaled, fromScaled, makeReport, normBalances, at, poll, sleep } from './lib.mjs';

const SYM = 'BTCUSDT';
const R = makeReport(`futures:${SYM}`);
const SC = 100000000n;
const ceil8 = (n, d) => (n + d - 1n) / d;
const snap1 = (v) => (Math.round(Number(v) * 10) / 10).toFixed(1); // tick 0.1

async function seedMark() {
  let mark = null;
  for (let i = 0; i < 5 && !mark; i++) {
    const s = await makeTrader('futSeed', { USDT: '500' });
    await signed(BASE.spot, 'POST', '/spot/trading/orders', { apiKey: s.key.apiKey, secret: s.key.secret, body: { tickerSymbol: SYM, tickerMarket: 'SPOT', type: 'MARKET', side: 'BUY', timeInForce: 'IOC', origQuoteQty: '60' } });
    mark = await poll(async () => { const m = await jwt(BASE.futures, 'GET', `/futures/market/mark-price?symbol=${SYM}`); return m.json.data?.markPrice ?? null; }, { tries: 12, intervalMs: 500 });
  }
  return mark;
}
const mark = await seedMark();
R.check('0a futures mark price established (seeded via spot trade)', !!mark, `markPrice=${mark}`);
if (!mark) { R.done(); process.exit(1); }

async function futUsdt(key) { const r = await signed(BASE.futures, 'GET', '/futures/account/balances', { apiKey: key.apiKey, secret: key.secret }); return at(normBalances(r.json.data, 'FUTURES'), 'USDT').total; }
async function income(key) {
  const r = await signed(BASE.futures, 'GET', '/futures/account/income', { apiKey: key.apiKey, secret: key.secret, query: { limit: '1000' } });
  const rows = r.json.data || []; let sum = 0n; const types = {}; const byType = {};
  for (const e of rows) { sum += toScaled(e.income); types[e.incomeType] = (types[e.incomeType] ?? 0) + 1; byType[e.incomeType] = (byType[e.incomeType] ?? 0n) + toScaled(e.income); }
  return { sum, types, byType, rows };
}
async function position(key) { const r = await signed(BASE.futures, 'GET', '/futures/account/positions', { apiKey: key.apiKey, secret: key.secret }); return (r.json.data || []).find((p) => p.symbol === SYM) || null; }
async function setLev(key, lev) { return signed(BASE.futures, 'PATCH', `/futures/trading/positions/${SYM}`, { apiKey: key.apiKey, secret: key.secret, body: { leverage: lev } }); }
async function limit(key, side, qty, price, reduceOnly = false) { return signed(BASE.futures, 'POST', '/futures/trading/orders', { apiKey: key.apiKey, secret: key.secret, body: { symbol: SYM, type: 'LIMIT', side, timeInForce: 'GTC', qty, price, reduceOnly } }); }
const hasQty = (p) => p && toScaled(p.qty) !== 0n;

// ============================================================
// CASE 1: two-user LONG/SHORT open + close — ledger conservation, PnL zero-sum, margin reserve
// ============================================================
{
  const LEV = 10, QTY = '0.010';
  const P = snap1(mark), P2 = snap1(Number(mark) + 50); // close 50 USDT higher -> A(long) profit, B(short) loss
  const A = await makeTrader('futLong', {}); await deposit(A.key, 'USDT', '5000'); await transfer(A.key, 'SPOT', 'FUTURES', 'USDT', '5000'); await setLev(A.key, LEV);
  const B = await makeTrader('futShort', {}); await deposit(B.key, 'USDT', '5000'); await transfer(B.key, 'SPOT', 'FUTURES', 'USDT', '5000'); await setLev(B.key, LEV);

  // OPEN: A LIMIT BUY rests (maker), B LIMIT SELL crosses (taker) -> A long, B short, entry P
  const ab = await limit(A.key, 'BUY', QTY, P);
  R.check('1a A open BUY accepted (rests)', ab.status === 201, `status=${ab.status} ${JSON.stringify(ab.json).slice(0,120)}`);
  const bs = await limit(B.key, 'SELL', QTY, P);
  R.check('1b B open SELL accepted', bs.status === 201, `status=${bs.status}`);
  const pa = await poll(async () => { const p = await position(A.key); return hasQty(p) ? p : null; }, { tries: 50, intervalMs: 250 });
  const pb = await poll(async () => { const p = await position(B.key); return hasQty(p) ? p : null; }, { tries: 50, intervalMs: 250 });
  R.check('1c A long & B short opened', !!pa && !!pb, `A.qty=${pa?.qty} B.qty=${pb?.qty} A.entry=${pa?.entryPrice}`);

  if (pa && pb) {
    // margin reserve check on both: isolatedMargin == ceil8(entry*|qty|/lev)
    const notA = (toScaled(pa.entryPrice) * (toScaled(pa.qty) < 0n ? -toScaled(pa.qty) : toScaled(pa.qty))) / SC;
    R.eqScaled('1d A isolatedMargin == ceil8(notional/lev)', toScaled(pa.isolatedMargin), ceil8(notA, BigInt(LEV)));
    const notB = (toScaled(pb.entryPrice) * (toScaled(pb.qty) < 0n ? -toScaled(pb.qty) : toScaled(pb.qty))) / SC;
    R.eqScaled('1e B isolatedMargin == ceil8(notional/lev)', toScaled(pb.isolatedMargin), ceil8(notB, BigInt(LEV)));

    // CLOSE at P2: A SELL reduceOnly rests, B BUY reduceOnly crosses
    const asell = await limit(A.key, 'SELL', QTY, P2, true);
    R.check('1f A close SELL (reduceOnly) accepted', asell.status === 201, `status=${asell.status} ${JSON.stringify(asell.json).slice(0,120)}`);
    const bbuy = await limit(B.key, 'BUY', QTY, P2, true);
    R.check('1g B close BUY (reduceOnly) accepted', bbuy.status === 201, `status=${bbuy.status}`);
    const flatA = await poll(async () => (!hasQty(await position(A.key)) ? true : null), { tries: 50, intervalMs: 250 });
    const flatB = await poll(async () => (!hasQty(await position(B.key)) ? true : null), { tries: 50, intervalMs: 250 });
    R.check('1h both positions flat after close', flatA && flatB, '');
    await sleep(600);

    // ledger conservation per user: futures wallet total == Σ income
    const wa = await futUsdt(A.key), incA = await income(A.key);
    const wb = await futUsdt(B.key), incB = await income(B.key);
    R.eqScaled('1i A LEDGER: wallet == Σ FuturesIncome', wa, incA.sum);
    R.eqScaled('1j B LEDGER: wallet == Σ FuturesIncome', wb, incB.sum);
    // PnL zero-sum: A realized + B realized == 0 (price move is a pure transfer between counterparties)
    const pnlA = incA.byType.REALIZED_PNL ?? 0n, pnlB = incB.byType.REALIZED_PNL ?? 0n;
    R.eqScaled('1k PnL zero-sum: A_realized + B_realized == 0', pnlA + pnlB, 0n);
    // direction + magnitude: A long closed higher -> profit (P2-P)*qty
    const expectPnlA = ((toScaled(P2) - toScaled(P)) * toScaled(QTY)) / SC;
    R.eqScaled('1l A realized PnL == (exit-entry)*qty', pnlA, expectPnlA, 1n);
    R.check('1m A profited, B lost equally (long up)', pnlA > 0n && pnlB < 0n, `A=${fromScaled(pnlA)} B=${fromScaled(pnlB)}`);
    // total system: A_wallet + B_wallet == 10000 - total_fees (fees left to insurance/fee sink)
    const fees = -((incA.byType.COMMISSION ?? 0n) + (incB.byType.COMMISSION ?? 0n)); // commissions negative
    R.eqScaled('1n A+B wallet == 10000 deposited - total commission', wa + wb, toScaled('10000') - fees);
  }
}

// ============================================================
// CASE 2: leverage bounds (flat set ok; > maxLeverage rejected; set-while-open rejected)
// ============================================================
{
  const T = await makeTrader('futLev', {}); await deposit(T.key, 'USDT', '5000'); await transfer(T.key, 'SPOT', 'FUTURES', 'USDT', '5000');
  const ok = await setLev(T.key, 20);
  R.check('2a set leverage 20 (flat) ok', ok.status === 200 || ok.status === 201, `status=${ok.status}`);
  const bad = await setLev(T.key, 9999);
  R.check('2b leverage > maxLeverage(50) rejected', bad.status >= 400, `status=${bad.status} code=${bad.json.code}`);
  // open then try to change leverage
  await setLev(T.key, 10);
  const C = await makeTrader('futCtr', {}); await deposit(C.key, 'USDT', '5000'); await transfer(C.key, 'SPOT', 'FUTURES', 'USDT', '5000'); await setLev(C.key, 10);
  const P = snap1(mark);
  await limit(T.key, 'BUY', '0.010', P); await limit(C.key, 'SELL', '0.010', P);
  const opened = await poll(async () => { const p = await position(T.key); return hasQty(p) ? p : null; }, { tries: 50, intervalMs: 250 });
  if (opened) {
    const whileOpen = await setLev(T.key, 25);
    R.check('2c set leverage while position open rejected (flat-only)', whileOpen.status >= 400, `status=${whileOpen.status} code=${whileOpen.json.code}`);
    await limit(T.key, 'SELL', '0.010', P, true); await limit(C.key, 'BUY', '0.010', P, true);
  } else R.check('2c set-leverage-while-open', false, 'could not open position to test');
}

// ============================================================
// CASE 3: insufficient margin rejection
// ============================================================
{
  const T = await makeTrader('futInsuf', {}); await deposit(T.key, 'USDT', '10'); await transfer(T.key, 'SPOT', 'FUTURES', 'USDT', '10'); await setLev(T.key, 1);
  const op = await limit(T.key, 'BUY', '0.1', snap1(mark)); // notional ~6500, margin ~6500 >> 10
  R.check('3a over-margin open rejected', op.status >= 400, `status=${op.status} code=${op.json.code} msg=${op.json.message}`);
  R.check('3b no position created on rejected open', !hasQty(await position(T.key)), '');
}

const out = R.done();
console.log('REPORT_JSON ' + JSON.stringify(out));
process.exit(out.failed ? 1 : 0);
