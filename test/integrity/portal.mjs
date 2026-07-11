// PORTAL integrity — transfers (cross-market conservation), deposit/withdraw ledger,
// subaccounts (conservation + isolation), API-key scope enforcement, JWT-escalation block.
import { BASE, signed, jwt, makeTrader, signup, issueApiKey, deposit, transfer, verifyEmail, toScaled, fromScaled, makeReport, normBalances, at, hmac } from './lib.mjs';

const R = makeReport('portal');

async function usdtAcross(key) {
  const out = {};
  for (const [mkt, base, path] of [['SPOT', BASE.spot, '/spot/account/balances'], ['FUTURES', BASE.futures, '/futures/account/balances']]) {
    const r = await signed(base, 'GET', path, { apiKey: key.apiKey, secret: key.secret });
    out[mkt] = at(normBalances(r.json.data, mkt), 'USDT').total;
  }
  out.TOTAL = out.SPOT + out.FUTURES;
  return out;
}

// ============================================================
// CASE 1: deposit/withdraw ledger == wallet delta (exact)
// ============================================================
{
  const email = `pFund-${Date.now()}@itest.local`;
  const u = await signup(email);
  const key = await issueApiKey(u.cookie, { canTrade: true, canRead: true });
  const T = { key };
  const spotUsdt = async () => { const r = await signed(BASE.spot, 'GET', '/spot/account/balances', { apiKey: key.apiKey, secret: key.secret }); return at(normBalances(r.json.data, 'SPOT'), 'USDT').total; };
  const b0 = await spotUsdt();
  await deposit(T.key, 'USDT', '1234.56789012');
  const b1 = await spotUsdt();
  R.eqScaled('1a deposit credits exactly', b1 - b0, toScaled('1234.56789012'));
  // withdrawal gated on email verification (security): blocked before verify
  const wdPre = await signed(BASE.portal, 'POST', '/account/withdrawals', { apiKey: key.apiKey, secret: key.secret, body: { assetSymbol: 'USDT', qty: '234.56789012' } });
  R.check('1b withdrawal blocked before email verification', wdPre.status === 403, `status=${wdPre.status} code=${wdPre.json.code} msg=${wdPre.json.message}`);
  // verify email via mailpit token (exercises the email-verification feature)
  await verifyEmail(email);
  const wd = await signed(BASE.portal, 'POST', '/account/withdrawals', { apiKey: key.apiKey, secret: key.secret, body: { assetSymbol: 'USDT', qty: '234.56789012' } });
  R.check('1c withdrawal accepted after verification', wd.status === 201, `status=${wd.status} ${JSON.stringify(wd.json).slice(0,120)}`);
  const b2 = await spotUsdt();
  R.eqScaled('1d withdrawal debits exactly', b1 - b2, toScaled('234.56789012'));
  const over = await signed(BASE.portal, 'POST', '/account/withdrawals', { apiKey: key.apiKey, secret: key.secret, body: { assetSymbol: 'USDT', qty: '99999999' } });
  R.check('1e over-balance withdrawal rejected (insufficient, not email-gate)', over.status >= 400 && over.json.code !== 60014, `status=${over.status} code=${over.json.code}`);
}

// ============================================================
// CASE 2: cross-market transfer conservation (SPOT<->FUTURES total constant)
// ============================================================
{
  const T = await makeTrader('pXfer', { USDT: '10000' });
  const a = await usdtAcross(T.key);
  await transfer(T.key, 'SPOT', 'FUTURES', 'USDT', '3000');
  await transfer(T.key, 'FUTURES', 'SPOT', 'USDT', '1000');
  const b = await usdtAcross(T.key);
  R.eqScaled('2a total USDT conserved across markets', b.TOTAL, a.TOTAL);
  R.eqScaled('2b futures got +3000-1000', b.FUTURES - a.FUTURES, toScaled('2000'));
  R.eqScaled('2c spot net -2000', a.SPOT - b.SPOT, toScaled('2000'));
  const over = await signed(BASE.portal, 'POST', '/account/transfers', { apiKey: T.key.apiKey, secret: T.key.secret, body: { fromMarket: 'SPOT', toMarket: 'FUTURES', assetSymbol: 'USDT', qty: '99999999' } });
  R.check('2d over-balance transfer rejected', over.status >= 400, `status=${over.status} code=${over.json.code}`);
}

// ============================================================
// CASE 3: subaccounts — conservation (master<->sub) + isolation
// ============================================================
{
  const master = await makeTrader('pMaster', { USDT: '5000' });
  // create subaccount via JWT cookie (escalation blocked: API key cannot do this)
  const created = await jwt(BASE.portal, 'POST', '/subaccounts', { cookie: master.cookie, body: { label: 'itest-sub' } });
  R.check('3a create subaccount (JWT)', created.status === 201, `status=${created.status} ${JSON.stringify(created.json).slice(0,120)}`);
  const subId = created.json.data?.id;
  // master spot before
  const mr0 = await signed(BASE.spot, 'GET', '/spot/account/balances', { apiKey: master.key.apiKey, secret: master.key.secret });
  const mUsdt0 = at(normBalances(mr0.json.data, 'SPOT'), 'USDT').total;
  // transfer master -> sub (SPOT)
  const masterId = master.userId;
  const xfer = await jwt(BASE.portal, 'POST', '/subaccounts/transfers', { cookie: master.cookie, body: { fromAccountId: masterId, toAccountId: subId, assetSymbol: 'USDT', market: 'SPOT', qty: '1500' } });
  R.check('3b master->sub transfer ok', xfer.status === 201, `status=${xfer.status} ${JSON.stringify(xfer.json).slice(0,120)}`);
  const mr1 = await signed(BASE.spot, 'GET', '/spot/account/balances', { apiKey: master.key.apiKey, secret: master.key.secret });
  const mUsdt1 = at(normBalances(mr1.json.data, 'SPOT'), 'USDT').total;
  R.eqScaled('3c master debited exactly 1500', mUsdt0 - mUsdt1, toScaled('1500'));
  const sb = await jwt(BASE.portal, 'GET', `/subaccounts/${subId}/balances`, { cookie: master.cookie });
  const subUsdt = at(normBalances(sb.json.data?.SPOT ?? sb.json.data?.spot ?? sb.json.data), 'USDT').total
    || at(normBalances(Array.isArray(sb.json.data) ? sb.json.data : (sb.json.data?.balances ?? [])), 'USDT').total;
  R.check('3d sub credited 1500 (conservation)', subUsdt === toScaled('1500'), `sub USDT=${fromScaled(subUsdt)} raw=${JSON.stringify(sb.json.data).slice(0,160)}`);
  // ISOLATION: an unrelated user cannot view this subaccount
  const stranger = await makeTrader('pStranger', {});
  const peek = await jwt(BASE.portal, 'GET', `/subaccounts/${subId}/balances`, { cookie: stranger.cookie });
  R.check('3e stranger cannot read others subaccount', peek.status >= 400, `status=${peek.status} code=${peek.json.code}`);
  const steal = await jwt(BASE.portal, 'POST', '/subaccounts/transfers', { cookie: stranger.cookie, body: { fromAccountId: subId, toAccountId: stranger.userId, assetSymbol: 'USDT', market: 'SPOT', qty: '1500' } });
  R.check('3f stranger cannot transfer out of others subaccount', steal.status >= 400, `status=${steal.status} code=${steal.json.code}`);
}

// ============================================================
// CASE 4: API-key scope enforcement + signature/timestamp guards + escalation block
// ============================================================
{
  const u = await signup(`pScope-${Date.now()}@itest.local`);
  await deposit(await issueApiKey(u.cookie, { canTrade: true, canRead: true }), 'USDT', '100'); // ensure wallet exists
  // read-only key (canTrade=false) attempts a TRADE endpoint -> rejected
  const roKey = await issueApiKey(u.cookie, { canTrade: false, canRead: true, label: 'ro' });
  const tradeAttempt = await signed(BASE.spot, 'POST', '/spot/trading/orders', { apiKey: roKey.apiKey, secret: roKey.secret, body: { tickerSymbol: 'LTCUSDT', tickerMarket: 'SPOT', type: 'LIMIT', side: 'BUY', timeInForce: 'GTC', price: '50.00', origQty: '1.000' } });
  R.check('4a read-only key blocked from trade (403)', tradeAttempt.status === 403, `status=${tradeAttempt.status} code=${tradeAttempt.json.code} msg=${tradeAttempt.json.message}`);
  // no-read key (canRead=false) attempts a READ endpoint -> rejected
  const noReadKey = await issueApiKey(u.cookie, { canTrade: true, canRead: false, label: 'nr' });
  const readAttempt = await signed(BASE.spot, 'GET', '/spot/account/balances', { apiKey: noReadKey.apiKey, secret: noReadKey.secret });
  R.check('4b no-read key blocked from read (403)', readAttempt.status === 403, `status=${readAttempt.status} code=${readAttempt.json.code}`);
  // bad signature -> 401
  const ts = Date.now();
  const badUrl = `${BASE.spot}/spot/account/balances?timestamp=${ts}&signature=deadbeef`;
  const bad = await fetch(badUrl, { headers: { 'X-API-KEY': roKey.apiKey } });
  R.check('4c invalid signature rejected (401)', bad.status === 401, `status=${bad.status}`);
  // stale timestamp -> 401 (outside recvWindow)
  const stale = Date.now() - 120000;
  const qs = `timestamp=${stale}`;
  const sig = hmac(roKey.secret, qs, '');
  const staleRes = await fetch(`${BASE.spot}/spot/account/balances?${qs}&signature=${sig}`, { headers: { 'X-API-KEY': roKey.apiKey } });
  R.check('4d stale timestamp rejected (401)', staleRes.status === 401, `status=${staleRes.status}`);
  // escalation: API key cannot create subaccounts (JwtOnly)
  const esc = await signed(BASE.portal, 'POST', '/subaccounts', { apiKey: roKey.apiKey, secret: roKey.secret, body: { label: 'x' } });
  R.check('4e API key cannot create subaccount (escalation blocked)', esc.status === 401 || esc.status === 403, `status=${esc.status} code=${esc.json.code}`);
}

const out = R.done();
console.log('REPORT_JSON ' + JSON.stringify(out));
process.exit(out.failed ? 1 : 0);
