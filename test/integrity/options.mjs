// OPTIONS integrity — END-TO-END IS BLOCKED (structurally complete, operationally inert):
//   * 0 OptionSeries rows and NO code path creates them (verified by exhaustive grep)
//   * the running Python match uses tickers.json (no options lane) -> orders cannot match
//   * SELL-open (writing) is explicitly Phase 4 (unimplemented)
// So we verify only what IS feasible: the app serves all read endpoints cleanly with an empty
// chain, and order intake validates/rejects unknown instruments rather than crashing.
import { BASE, signed, jwt, makeTrader, makeReport } from './lib.mjs';

const R = makeReport('options (read + intake; e2e blocked)');

// ---- public/market read endpoints serve cleanly with 0 series ----
for (const [name, path] of [['instruments', '/options/market/instruments'], ['chain', '/options/market/chain?underlying=BTCUSDT'], ['mark', '/options/market/mark?symbol=BTC-26JUN26-60000-C'], ['depth', '/options/market/depth?symbol=BTC-26JUN26-60000-C'], ['recent-trades', '/options/market/recent-trades?symbol=BTC-26JUN26-60000-C']]) {
  const r = await jwt(BASE.options, 'GET', path);
  R.check(`read ${name} serves without error`, r.status === 200, `status=${r.status} data=${JSON.stringify(r.json?.data ?? r.json).slice(0,80)}`);
}

// instruments is empty (confirms the blocked state)
{
  const r = await jwt(BASE.options, 'GET', '/options/market/instruments');
  const arr = r.json.data ?? [];
  R.check('instruments list is empty (0 OptionSeries — e2e blocked)', Array.isArray(arr) && arr.length === 0, `count=${arr.length}`);
}

// ---- authenticated account reads serve cleanly ----
{
  const T = await makeTrader('optRead', {});
  for (const [name, path] of [['balances', '/options/account/balances'], ['positions', '/options/account/positions'], ['open-orders', '/options/account/open-orders'], ['orders', '/options/account/orders'], ['trades', '/options/account/trades'], ['income', '/options/account/income'], ['settlements', '/options/account/settlements']]) {
    const r = await signed(BASE.options, 'GET', path, { apiKey: T.key.apiKey, secret: T.key.secret });
    R.check(`account ${name} serves without error`, r.status === 200, `status=${r.status}`);
  }
  // ---- order intake validation: unknown instrument is rejected (4xx), not a 500 crash ----
  const ord = await signed(BASE.options, 'POST', '/options/trading/orders', { apiKey: T.key.apiKey, secret: T.key.secret, body: { symbol: 'BTC-26JUN26-60000-C', type: 'LIMIT', side: 'BUY', timeInForce: 'GTC', price: '1250.0', qty: '1.0' } });
  R.check('order for unknown instrument rejected 4xx (not 5xx crash)', ord.status >= 400 && ord.status < 500, `status=${ord.status} code=${ord.json.code} msg=${ord.json.message}`);
  // bad payload (missing price) -> 400 validation
  const bad = await signed(BASE.options, 'POST', '/options/trading/orders', { apiKey: T.key.apiKey, secret: T.key.secret, body: { symbol: 'X', type: 'LIMIT', side: 'BUY', qty: '1.0' } });
  R.check('malformed order rejected (validation)', bad.status === 400, `status=${bad.status}`);
}

const out = R.done();
console.log('REPORT_JSON ' + JSON.stringify(out));
console.log('NOTE: options end-to-end (match/fill/settlement) is BLOCKED — see header comment.');
process.exit(out.failed ? 1 : 0);
