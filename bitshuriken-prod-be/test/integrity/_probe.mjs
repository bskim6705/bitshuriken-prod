import { BASE, signed, jwt, makeTrader, deposit } from './lib.mjs';

const TICK = process.env.TICK ?? 'LTCUSDT';

// public market data
const xi = await jwt(BASE.spot, 'GET', `/spot/market/exchange-info?symbol=${TICK}`);
console.log('exchange-info status', xi.status);
console.log(JSON.stringify(xi.json?.data ?? xi.json).slice(0, 700));

const depth = await jwt(BASE.spot, 'GET', `/spot/market/depth?symbol=${TICK}&limit=5`);
console.log('\ndepth status', depth.status, JSON.stringify(depth.json?.data ?? depth.json).slice(0, 300));

// account primitives
const t = await makeTrader('probe', { USDT: '50000', LTC: '100' });
console.log('\ntrader', t.userId, t.email);

const bal = await signed(BASE.spot, 'GET', '/spot/account/balances', { apiKey: t.key.apiKey, secret: t.key.secret });
console.log('balances status', bal.status);
console.log(JSON.stringify(bal.json?.data ?? bal.json).slice(0, 500));

// place a resting LIMIT SELL (empty book -> should rest as NEW)
const place = await signed(BASE.spot, 'POST', '/spot/trading/orders', {
  apiKey: t.key.apiKey, secret: t.key.secret,
  body: { tickerSymbol: TICK, tickerMarket: 'SPOT', type: 'LIMIT', side: 'SELL', timeInForce: 'GTC', price: '999.00000000', origQty: '1.00000000' },
});
console.log('\nplace SELL status', place.status);
console.log(JSON.stringify(place.json).slice(0, 600));
const orderId = place.json?.data?.id ?? place.json?.data?.orderId;

if (orderId) {
  const ord = await signed(BASE.spot, 'GET', `/spot/account/orders/${orderId}`, { apiKey: t.key.apiKey, secret: t.key.secret });
  console.log('\norder status', ord.status, JSON.stringify(ord.json?.data ?? ord.json).slice(0, 400));
  const cancel = await signed(BASE.spot, 'DELETE', `/spot/trading/orders/${orderId}`, { apiKey: t.key.apiKey, secret: t.key.secret });
  console.log('\ncancel status', cancel.status, JSON.stringify(cancel.json?.data ?? cancel.json).slice(0, 300));
}
