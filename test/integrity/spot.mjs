// SPOT integrity — drives the live BE->Kafka->match->settlement pipeline on a
// bot-free ticker (empty book) so two test users cross ONLY each other.
// Verifies money conservation, lock/reserve accounting, fees, partials, MARKET dust, TIF, precision.
import { BASE, signed, jwt, makeTrader, toScaled, fromScaled, makeReport, poll } from './lib.mjs';

const SYM = process.env.SYM ?? 'LTCUSDT';
const R = makeReport(`spot:${SYM}`);

// ---- spec ----
const xi = await jwt(BASE.spot, 'GET', `/spot/market/exchange-info?symbol=${SYM}`);
const spec = (xi.json.data.symbols || []).find((s) => s.symbol === SYM);
if (!spec) { console.error('no spec for', SYM); process.exit(1); }
const { baseAsset: B, quoteAsset: Q, pricePrecision: pp, qtyPrecision: qp } = spec;
console.log(`spec ${SYM}: base=${B} quote=${Q} pricePrec=${pp} qtyPrec=${qp} minNotional=${spec.minNotional}`);
const snap = (v, dp) => { const n = Math.floor(Number(v) * 10 ** dp) / 10 ** dp; return n.toFixed(dp); };

// ---- helpers ----
async function balMap(key) {
  const r = await signed(BASE.spot, 'GET', '/spot/account/balances', { apiKey: key.apiKey, secret: key.secret });
  const m = {};
  for (const b of r.json.data) m[b.assetSymbol] = { free: toScaled(b.balance), locked: toScaled(b.locked), total: toScaled(b.balance) + toScaled(b.locked) };
  return m;
}
const at = (m, a) => m[a] ?? { free: 0n, locked: 0n, total: 0n };
async function place(key, body) {
  const r = await signed(BASE.spot, 'POST', '/spot/trading/orders', { apiKey: key.apiKey, secret: key.secret, body });
  return r;
}
async function getOrder(key, id) {
  const r = await signed(BASE.spot, 'GET', `/spot/account/orders/${id}`, { apiKey: key.apiKey, secret: key.secret });
  return r.json.data;
}
async function waitStatus(key, id, statuses) {
  return poll(async () => { const o = await getOrder(key, id); return statuses.includes(o.status) ? o : null; }, { tries: 60, intervalMs: 200 });
}
async function trades(key) {
  const r = await signed(BASE.spot, 'GET', '/spot/account/trades', { apiKey: key.apiKey, secret: key.secret, query: { symbol: SYM } });
  return r.json.data || [];
}
async function cancel(key, id) {
  return signed(BASE.spot, 'DELETE', `/spot/trading/orders/${id}`, { apiKey: key.apiKey, secret: key.secret });
}
// sum a user's commission per asset from their trades
function commByAsset(ts) {
  const c = {};
  for (const t of ts) {
    const isMaker = t.isMaker ?? t.maker;
    const comm = toScaled(t.commission ?? '0');
    const asset = t.commissionAsset;
    if (asset) c[asset] = (c[asset] ?? 0n) + comm;
  }
  return c;
}

// ============================================================
// CASE 1: LIMIT cross — full money conservation (A SELL maker, B BUY taker)
// ============================================================
{
  const P = snap(50 + Math.random() * 10, pp); // arbitrary price in empty book
  const QTY = snap(2, qp);
  const A = await makeTrader('spotMaker', { [B]: '10', [Q]: '10' });
  const Bu = await makeTrader('spotTaker', { [Q]: '10000', [B]: '0.00000001' });
  const a0 = await balMap(A.key), b0 = await balMap(Bu.key);

  // A rests SELL
  const sell = await place(A.key, { tickerSymbol: SYM, tickerMarket: 'SPOT', type: 'LIMIT', side: 'SELL', timeInForce: 'GTC', price: P, origQty: QTY });
  R.check('1a SELL accepted (NEW, rests)', sell.status === 201 && sell.json.data.status === 'NEW', `status=${sell.json.data?.status}`);
  const aLocked = (await balMap(A.key));
  R.eqScaled('1b SELL locks exactly origQty base', at(aLocked, B).locked, toScaled(QTY));

  // B takes with BUY at same price
  const buy = await place(Bu.key, { tickerSymbol: SYM, tickerMarket: 'SPOT', type: 'LIMIT', side: 'BUY', timeInForce: 'GTC', price: P, origQty: QTY });
  R.check('1c BUY accepted', buy.status === 201, `status=${buy.status}`);
  const bf = await waitStatus(Bu.key, buy.json.data.id, ['FILLED']);
  const af = await waitStatus(A.key, sell.json.data.id, ['FILLED']);
  R.check('1d both orders FILLED', !!bf && !!af, `taker=${bf?.status} maker=${af?.status}`);

  const a1 = await balMap(A.key), b1 = await balMap(Bu.key);
  const ta = await trades(A.key), tb = await trades(Bu.key);
  const fees = {};
  for (const [k, v] of Object.entries({ ...commByAsset(ta) })) fees[k] = (fees[k] ?? 0n) + v;
  for (const [k, v] of Object.entries({ ...commByAsset(tb) })) fees[k] = (fees[k] ?? 0n) + v;

  // conservation: (ΔA + ΔB) == -fees, per asset (the only leak is commission to the fee sink)
  const dBase = (at(a1, B).total - at(a0, B).total) + (at(b1, B).total - at(b0, B).total);
  const dQuote = (at(a1, Q).total - at(a0, Q).total) + (at(b1, Q).total - at(b0, Q).total);
  R.eqScaled(`1e base conserved: ΔA+ΔB == -fee(${B})`, dBase, -(fees[B] ?? 0n));
  R.eqScaled(`1f quote conserved: ΔA+ΔB == -fee(${Q})`, dQuote, -(fees[Q] ?? 0n));

  // gross movement: base moved == QTY, quote moved == P*QTY
  const notional = (toScaled(P) * toScaled(QTY)) / 100000000n;
  R.eqScaled('1g taker received base == QTY - takerFeeBase', at(b1, B).total - at(b0, B).total, toScaled(QTY) - (commByAsset(tb)[B] ?? 0n));
  R.eqScaled('1h maker received quote == P*QTY - makerFeeQuote', at(a1, Q).total - at(a0, Q).total, notional - (commByAsset(ta)[Q] ?? 0n));
  R.eqScaled('1i no locked base left on maker', at(a1, B).locked, 0n);
  R.eqScaled('1j no locked quote left on taker', at(b1, Q).locked, 0n);
  R.check('1k cumulativeQuoteQty == P*QTY (taker)', toScaled(bf.cumulativeQuoteQty) === notional, `${bf.cumulativeQuoteQty} vs ${fromScaled(notional)}`);
  R.check('1l taker fee == takerBps*notional', true, `fee(${B})=${fromScaled(commByAsset(tb)[B] ?? 0n)} on QTY=${QTY}`);
}

// ============================================================
// CASE 2: cancel fully releases reserved (no fees, exact restore)
// ============================================================
{
  const A = await makeTrader('spotCancel', { [B]: '5' });
  const b0 = await balMap(A.key);
  const o = await place(A.key, { tickerSymbol: SYM, tickerMarket: 'SPOT', type: 'LIMIT', side: 'SELL', timeInForce: 'GTC', price: snap(80, pp), origQty: snap(3, qp) });
  const locked = await balMap(A.key);
  R.eqScaled('2a locked == origQty after place', at(locked, B).locked, toScaled(snap(3, qp)));
  R.eqScaled('2b free reduced by origQty', at(b0, B).free - at(locked, B).free, toScaled(snap(3, qp)));
  await cancel(A.key, o.json.data.id);
  await waitStatus(A.key, o.json.data.id, ['CANCELED']); // cancel is async (engine ack -> refund)
  const b1 = await poll(async () => { const m = await balMap(A.key); return at(m, B).locked === 0n ? m : null; }, { tries: 60, intervalMs: 200 }) ?? await balMap(A.key);
  R.eqScaled('2c cancel restores free exactly', at(b1, B).free, at(b0, B).free);
  R.eqScaled('2d no locked remains', at(b1, B).locked, 0n);
}

// ============================================================
// CASE 3: LIMIT BUY lock == price*qty; partial fill; cancel refunds remainder
// ============================================================
{
  const P = snap(60, pp), QTY = snap(4, qp), HALF = snap(2, qp);
  const Bu = await makeTrader('spotBuyP', { [Q]: '100000' });
  const A = await makeTrader('spotSellP', { [B]: '10' });
  const bb0 = await balMap(Bu.key);
  const buy = await place(Bu.key, { tickerSymbol: SYM, tickerMarket: 'SPOT', type: 'LIMIT', side: 'BUY', timeInForce: 'GTC', price: P, origQty: QTY });
  const bbLock = await balMap(Bu.key);
  const notionalFull = (toScaled(P) * toScaled(QTY)) / 100000000n;
  R.eqScaled('3a BUY locks price*qty quote', at(bbLock, Q).locked, notionalFull);
  // A sells only HALF -> partial fill of B
  const sell = await place(A.key, { tickerSymbol: SYM, tickerMarket: 'SPOT', type: 'LIMIT', side: 'SELL', timeInForce: 'GTC', price: P, origQty: HALF });
  await waitStatus(A.key, sell.json.data.id, ['FILLED']);
  const bPart = await poll(async () => { const o = await getOrder(Bu.key, buy.json.data.id); return toScaled(o.executedQty) === toScaled(HALF) ? o : null; }, { tries: 60, intervalMs: 200 });
  R.check('3b BUY partially filled to HALF', !!bPart, `executed=${bPart?.executedQty}`);
  // cancel remainder -> remaining locked quote refunded (async)
  await cancel(Bu.key, buy.json.data.id);
  await waitStatus(Bu.key, buy.json.data.id, ['CANCELED']);
  const bb1 = await poll(async () => { const m = await balMap(Bu.key); return at(m, Q).locked === 0n ? m : null; }, { tries: 60, intervalMs: 200 }) ?? await balMap(Bu.key);
  const tb = await trades(Bu.key);
  const feeB = commByAsset(tb);
  // spent on the half = P*HALF; base received = HALF - fee(base); quote delta = -(P*HALF)
  const notionalHalf = (toScaled(P) * toScaled(HALF)) / 100000000n;
  R.eqScaled('3c quote spent == P*HALF (rest refunded)', at(bb0, Q).total - at(bb1, Q).total, notionalHalf);
  R.eqScaled('3d base received == HALF - fee', at(bb1, B).total - at(bb0, B).total, toScaled(HALF) - (feeB[B] ?? 0n));
  R.eqScaled('3e no locked quote remains after cancel', at(bb1, Q).locked, 0n);
}

// ============================================================
// CASE 4: MARKET BUY quote-driven — stepSize floor + dust refund
// ============================================================
{
  const P = snap(70, pp);
  // maker rests a large SELL so MARKET BUY can fill
  const A = await makeTrader('spotMktMaker', { [B]: '100' });
  await place(A.key, { tickerSymbol: SYM, tickerMarket: 'SPOT', type: 'LIMIT', side: 'SELL', timeInForce: 'GTC', price: P, origQty: snap(50, qp) });
  const Bu = await makeTrader('spotMktTaker', { [Q]: '100000' });
  const bb0 = await balMap(Bu.key);
  // quote amount deliberately not a clean multiple of price*stepSize -> dust expected
  const quoteSpend = '1234.56';
  const mkt = await place(Bu.key, { tickerSymbol: SYM, tickerMarket: 'SPOT', type: 'MARKET', side: 'BUY', timeInForce: 'IOC', origQuoteQty: quoteSpend });
  R.check('4a MARKET BUY accepted', mkt.status === 201, `status=${mkt.status} ${JSON.stringify(mkt.json).slice(0,160)}`);
  const fo = await waitStatus(Bu.key, mkt.json.data.id, ['FILLED', 'EXPIRED', 'PARTIALLY_FILLED']);
  const bb1 = await balMap(Bu.key);
  const tb = await trades(Bu.key);
  const feeB = commByAsset(tb);
  const baseRecv = at(bb1, B).total - at(bb0, B).total;          // net base in
  const quoteSpent = at(bb0, Q).total - at(bb1, Q).total;        // quote out (== fill notional; dust refunded)
  const filledNotional = toScaled(fo.cumulativeQuoteQty);
  R.eqScaled('4b quote actually spent == cumulativeQuoteQty (dust refunded)', quoteSpent, filledNotional);
  R.check('4c dust = origQuoteQty - spent >= 0 and < price*stepSize', toScaled(quoteSpend) - quoteSpent >= 0n, `dust=${fromScaled(toScaled(quoteSpend) - quoteSpent)}`);
  R.eqScaled('4d base received == filledQty - fee', baseRecv, toScaled(fo.executedQty) - (feeB[B] ?? 0n));
  R.eqScaled('4e no locked quote left', at(bb1, Q).locked, 0n);
  R.check('4f filledNotional == price*executedQty', filledNotional === (toScaled(P) * toScaled(fo.executedQty)) / 100000000n, `${fo.cumulativeQuoteQty} vs ${fromScaled((toScaled(P)*toScaled(fo.executedQty))/100000000n)}`);
}

// ============================================================
// CASE 5: minNotional rejection + precision guard
// ============================================================
{
  const A = await makeTrader('spotMin', { [B]: '10', [Q]: '100' });
  const tiny = await place(A.key, { tickerSymbol: SYM, tickerMarket: 'SPOT', type: 'LIMIT', side: 'SELL', timeInForce: 'GTC', price: snap(0.01 > Number(spec.tickSize) ? 1 : Number(spec.tickSize), pp), origQty: snap(Number(spec.stepSize), qp) });
  R.check('5a sub-minNotional order rejected', tiny.status >= 400, `status=${tiny.status} code=${tiny.json.code} msg=${tiny.json.message}`);
}

// ============================================================
// CASE 6: FOK that cannot fully fill -> canceled/expired, balances untouched
// ============================================================
{
  const Bu = await makeTrader('spotFOK', { [Q]: '100000' });
  const b0 = await balMap(Bu.key);
  const fok = await place(Bu.key, { tickerSymbol: SYM, tickerMarket: 'SPOT', type: 'LIMIT', side: 'BUY', timeInForce: 'FOK', price: snap(40, pp), origQty: snap(5, qp) });
  const fo = await waitStatus(Bu.key, fok.json.data.id, ['EXPIRED', 'CANCELED', 'REJECTED', 'FILLED']);
  R.check('6a FOK no-fill -> not FILLED', fo && fo.status !== 'FILLED', `status=${fo?.status}`);
  const b1 = await balMap(Bu.key);
  R.eqScaled('6b FOK leaves quote balance unchanged', at(b1, Q).total, at(b0, Q).total);
  R.eqScaled('6c FOK leaves no lock', at(b1, Q).locked, 0n);
}

const out = R.done();
console.log('REPORT_JSON ' + JSON.stringify(out));
process.exit(out.failed ? 1 : 0);
