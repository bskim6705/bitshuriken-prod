import { config, apiBase } from './config';
import { makeLogger } from './log';
import type { Market } from './types';

// Opportunity scanner — OBSERVATION ONLY (no orders). Reads the local exchange's public market
// data (which mirrors Binance + Upbit) and reports trading opportunities a crypto-exchange operator
// would look for: kimchi premium (USDT vs KRW), triangular spread, and perp basis + funding carry.

const log = makeLogger('scan');

interface Spec {
  symbol: string;
  market: Market;
  baseAsset: string;
  quoteAsset: string;
}

async function exchangeInfo(market: Market): Promise<Spec[]> {
  const path = market === 'SPOT' ? '/spot/market/exchange-info' : '/futures/market/exchange-info';
  const res = await fetch(`${apiBase(market)}${path}`);
  if (!res.ok) return [];
  const env = (await res.json()) as {
    data: { symbols: { symbol: string; baseAsset: string; quoteAsset: string }[] };
  };
  return env.data.symbols.map((s) => ({ symbol: s.symbol, market, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }));
}

async function mid(market: Market, symbol: string): Promise<number | null> {
  const path = market === 'SPOT' ? '/spot/market/depth' : '/futures/market/depth';
  try {
    const res = await fetch(`${apiBase(market)}${path}?symbol=${symbol}&limit=5`);
    if (!res.ok) return null;
    const env = (await res.json()) as { data: { bids: [string, string][]; asks: [string, string][] } };
    const b = env.data.bids[0];
    const a = env.data.asks[0];
    if (!b || !a) return null;
    return (Number(b[0]) + Number(a[0])) / 2;
  } catch {
    return null;
  }
}

async function fundingRate(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`${config.api.futures}/futures/market/funding-rate?symbol=${symbol}`);
    if (!res.ok) return null;
    const env = (await res.json()) as { data?: { lastFundingRate?: string | null } };
    const r = env.data?.lastFundingRate;
    return r == null ? null : Number(r);
  } catch {
    return null;
  }
}

const pct = (x: number): string => `${(x * 100).toFixed(3)}%`;

async function once(): Promise<void> {
  const [spot, fut] = await Promise.all([exchangeInfo('SPOT'), exchangeInfo('FUTURES')]);
  const midOf = new Map<string, number>();
  await Promise.all(
    [...spot, ...fut].map(async (s) => {
      const m = await mid(s.market, s.symbol);
      if (m != null) midOf.set(`${s.market}:${s.symbol}`, m);
    }),
  );

  // USDT/KRW rate (kimchi conversion). Prefer a listed USDTKRW market.
  const usdtKrw = midOf.get('SPOT:USDTKRW') ?? null;

  console.log(`\n═══ opportunity scan — ${new Date().toTimeString().slice(0, 8)} ═══`);

  // --- kimchi premium: base priced in KRW vs base priced in USDT × USDTKRW ---
  const krwSpot = spot.filter((s) => s.quoteAsset === 'KRW' && s.baseAsset !== 'USDT');
  if (krwSpot.length && usdtKrw) {
    console.log('KIMCHI PREMIUM (KRW market vs USDT market × USDTKRW):');
    for (const k of krwSpot) {
      const krw = midOf.get(`SPOT:${k.symbol}`);
      const usdt = midOf.get(`SPOT:${k.baseAsset}USDT`);
      if (krw == null || usdt == null) continue;
      const premium = krw / (usdt * usdtKrw) - 1;
      console.log(`  ${k.baseAsset}: KRW ${krw.toFixed(0)} vs synth ${(usdt * usdtKrw).toFixed(0)} → ${pct(premium)}`);
    }
  } else if (krwSpot.length) {
    console.log('KIMCHI PREMIUM: skipped (no USDTKRW market listed to convert)');
  }

  // --- perp basis + funding carry: perp vs spot (same USDT pair) ---
  const perps = fut.filter((s) => s.market === 'FUTURES');
  if (perps.length) {
    console.log('PERP BASIS + FUNDING CARRY (perp vs spot):');
    for (const p of perps) {
      const perp = midOf.get(`FUTURES:${p.symbol}`);
      const spotMid = midOf.get(`SPOT:${p.symbol}`);
      if (perp == null || spotMid == null) continue;
      const basis = perp / spotMid - 1;
      const fr = await fundingRate(p.symbol);
      const carry = fr == null ? '' : ` funding=${pct(fr)}/8h (${pct(fr * 3 * 365)}/yr)`;
      console.log(`  ${p.symbol}: basis ${pct(basis)}${carry}`);
    }
  }
}

async function main(): Promise<void> {
  const watch = process.argv.includes('--watch');
  if (!watch) {
    await once();
    return;
  }
  log.info('scanning every 5s (Ctrl-C to stop)');
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });
  while (!stop) {
    try {
      await once();
    } catch (e) {
      log.err(e instanceof Error ? e.message : String(e));
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

void main();
