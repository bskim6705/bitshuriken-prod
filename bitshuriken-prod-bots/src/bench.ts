import fs from 'node:fs';
import { apiBase } from './config';
import { makeLogger } from './log';
import type { Market } from './types';

/**
 * Mirror-precision bench — OBSERVATION ONLY (no orders). Reproducible measurement of the two
 * fidelity axes the one-off 07-12 numbers came from (they had no committed tooling):
 *
 *  1. top-of-book tracking: samples local vs source best bid/ask once per SAMPLE_MS for
 *     --minutes, reports per-symbol |mid-deviation| percentiles (median/p95/p99/max, bps)
 *     plus spread comparison. Sources are fetched in ONE batched REST call per venue per tick
 *     (Binance bookTicker-all, Upbit orderbook-multi), so the bench itself is rate-light.
 *  2. candle fidelity: after sampling, compares the run window's COMPLETED local 1m candles
 *     against the source venue's (H/L/C deviation in bps, volume ratio).
 *
 * Usage: npm run bench [-- --minutes 5 --sample-ms 1000 --out bench.json]
 * Fidelity claims in reports should cite this bench's output (ADR-070).
 */
const log = makeLogger('bench');

interface Spec {
  symbol: string;
  market: Market;
  baseAsset: string;
  quoteAsset: string;
}
interface Tob {
  bid: number;
  ask: number;
}
interface Sample {
  devMidBps: number;
  devBidBps: number;
  devAskBps: number;
  locSpreadBps: number;
  srcSpreadBps: number;
}
interface Candle {
  openTime: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const argStr = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
};

const pct = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : NaN;

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

// ---- local exchange ----
async function localSpecs(market: Market): Promise<Spec[]> {
  const path = market === 'SPOT' ? '/spot/market/exchange-info' : '/futures/market/exchange-info';
  const env = await json<{ data: { symbols: Spec[] } }>(`${apiBase(market)}${path}`);
  return env.data.symbols.map((s) => ({ ...s, market }));
}

async function localTob(spec: Spec): Promise<Tob | null> {
  const path = spec.market === 'SPOT' ? '/spot/market/depth' : '/futures/market/depth';
  const env = await json<{ data: { bids: [string, string][]; asks: [string, string][] } }>(
    `${apiBase(spec.market)}${path}?symbol=${spec.symbol}&limit=1`,
  ).catch(() => null);
  const bid = Number(env?.data.bids[0]?.[0]);
  const ask = Number(env?.data.asks[0]?.[0]);
  return bid > 0 && ask > 0 ? { bid, ask } : null;
}

async function localCandles(spec: Spec, limit: number): Promise<Candle[]> {
  const path = spec.market === 'SPOT' ? '/spot/market/klines' : '/futures/market/klines';
  const env = await json<{
    data: { openTime: number; high: string; low: string; close: string; volume: string; isFinal: boolean }[];
  }>(`${apiBase(spec.market)}${path}?symbol=${spec.symbol}&interval=1m&limit=${limit + 2}`);
  return env.data
    .filter((k) => k.isFinal)
    .map((k) => ({ openTime: k.openTime, high: +k.high, low: +k.low, close: +k.close, volume: +k.volume }));
}

// ---- sources (batched per venue) ----
const upbitCode = (s: Spec): string => `${s.quoteAsset}-${s.baseAsset}`;

async function sourceTobs(specs: Spec[]): Promise<Map<string, Tob>> {
  const out = new Map<string, Tob>(); // key: MARKET:SYMBOL
  const binSpot = specs.filter((s) => s.market === 'SPOT' && s.quoteAsset !== 'KRW');
  const binFut = specs.filter((s) => s.market === 'FUTURES');
  const upbit = specs.filter((s) => s.market === 'SPOT' && s.quoteAsset === 'KRW');
  const jobs: Promise<void>[] = [];
  if (binSpot.length)
    jobs.push(
      json<{ symbol: string; bidPrice: string; askPrice: string }[]>(
        'https://api.binance.com/api/v3/ticker/bookTicker',
      ).then((all) => {
        const by = new Map(all.map((t) => [t.symbol, t]));
        for (const s of binSpot) {
          const t = by.get(s.symbol);
          if (t) out.set(`SPOT:${s.symbol}`, { bid: +t.bidPrice, ask: +t.askPrice });
        }
      }),
    );
  if (binFut.length)
    jobs.push(
      json<{ symbol: string; bidPrice: string; askPrice: string }[]>(
        'https://fapi.binance.com/fapi/v1/ticker/bookTicker',
      ).then((all) => {
        const by = new Map(all.map((t) => [t.symbol, t]));
        for (const s of binFut) {
          const t = by.get(s.symbol);
          if (t) out.set(`FUTURES:${s.symbol}`, { bid: +t.bidPrice, ask: +t.askPrice });
        }
      }),
    );
  if (upbit.length)
    jobs.push(
      json<{ market: string; orderbook_units: { bid_price: number; ask_price: number }[] }[]>(
        `https://api.upbit.com/v1/orderbook?markets=${upbit.map(upbitCode).join(',')}`,
      ).then((books) => {
        const by = new Map(books.map((b) => [b.market, b.orderbook_units[0]]));
        for (const s of upbit) {
          const u = by.get(upbitCode(s));
          if (u) out.set(`SPOT:${s.symbol}`, { bid: u.bid_price, ask: u.ask_price });
        }
      }),
    );
  await Promise.allSettled(jobs);
  return out;
}

async function sourceCandles(spec: Spec, limit: number): Promise<Candle[]> {
  if (spec.quoteAsset === 'KRW') {
    const rows = await json<
      { candle_date_time_utc: string; high_price: number; low_price: number; trade_price: number; candle_acc_trade_volume: number }[]
    >(`https://api.upbit.com/v1/candles/minutes/1?market=${upbitCode(spec)}&count=${limit + 2}`);
    return rows.map((r) => ({
      openTime: Date.parse(`${r.candle_date_time_utc}Z`),
      high: r.high_price,
      low: r.low_price,
      close: r.trade_price,
      volume: r.candle_acc_trade_volume,
    }));
  }
  const host =
    spec.market === 'SPOT' ? 'https://api.binance.com/api/v3/klines' : 'https://fapi.binance.com/fapi/v1/klines';
  const rows = await json<[number, string, string, string, string, string][]>(
    `${host}?symbol=${spec.symbol}&interval=1m&limit=${limit + 2}`,
  );
  return rows.map((r) => ({ openTime: r[0], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }));
}

// ---- bench ----
async function main(): Promise<void> {
  const minutes = arg('minutes', 5);
  const sampleMs = arg('sample-ms', 1000);
  const out = argStr('out');

  const all = [...(await localSpecs('SPOT')), ...(await localSpecs('FUTURES').catch(() => [] as Spec[]))];
  // probe with retries — a book momentarily one-sided (mid-walk) must not exclude its symbol
  // from the whole run; unusable moments are skipped per-tick instead.
  let candidates = all.map((s) => ({ s, ok: false }));
  for (let attempt = 0; attempt < 3; attempt++) {
    await Promise.all(
      candidates.filter((c) => !c.ok).map(async (c) => {
        c.ok = (await localTob(c.s)) !== null;
      }),
    );
    if (candidates.some((c) => !c.ok)) await new Promise((r) => setTimeout(r, 3000));
  }
  const specs = candidates.filter((c) => c.ok).map((c) => c.s);
  if (!specs.length) throw new Error('no symbol has a usable local book — is the mirror running?');
  log.info(
    `sampling ${specs.length} symbols every ${sampleMs}ms for ${minutes}min: ` +
      specs.map((s) => `${s.market === 'FUTURES' ? 'F:' : ''}${s.symbol}`).join(', '),
  );

  const series = new Map<string, Sample[]>(specs.map((s) => [`${s.market}:${s.symbol}`, []]));
  const startedAt = Date.now();
  const until = startedAt + minutes * 60_000;
  let ticks = 0;
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });
  while (Date.now() < until && !stop) {
    const tickStart = Date.now();
    const [src, locals] = await Promise.all([
      sourceTobs(specs),
      Promise.all(specs.map((s) => localTob(s))),
    ]);
    specs.forEach((s, i) => {
      const loc = locals[i];
      const ref = src.get(`${s.market}:${s.symbol}`);
      if (!loc || !ref) return;
      const srcMid = (ref.bid + ref.ask) / 2;
      const locMid = (loc.bid + loc.ask) / 2;
      series.get(`${s.market}:${s.symbol}`)!.push({
        devMidBps: ((locMid - srcMid) / srcMid) * 1e4,
        devBidBps: ((loc.bid - ref.bid) / ref.bid) * 1e4,
        devAskBps: ((loc.ask - ref.ask) / ref.ask) * 1e4,
        locSpreadBps: ((loc.ask - loc.bid) / locMid) * 1e4,
        srcSpreadBps: ((ref.ask - ref.bid) / srcMid) * 1e4,
      });
    });
    ticks++;
    if (ticks % 30 === 0) log.info(`… ${ticks} ticks (${Math.round((until - Date.now()) / 1000)}s left)`);
    await new Promise((r) => setTimeout(r, Math.max(50, sampleMs - (Date.now() - tickStart))));
  }

  // ---- report: top-of-book tracking ----
  console.log(`\n═══ TOP-OF-BOOK tracking — ${ticks} ticks @ ${sampleMs}ms ═══`);
  console.log('  |mid deviation| bps: median / p95 / p99 / max   ·   spread loc/src bps (median)');
  const summary: Record<string, unknown>[] = [];
  for (const s of specs) {
    const key = `${s.market}:${s.symbol}`;
    const rows = series.get(key)!;
    if (!rows.length) {
      console.log(`  ${key.padEnd(16)} NO SAMPLES (source or local book unavailable)`);
      summary.push({ symbol: key, samples: 0 });
      continue;
    }
    const absMid = rows.map((r) => Math.abs(r.devMidBps)).sort((a, b) => a - b);
    const locSp = rows.map((r) => r.locSpreadBps).sort((a, b) => a - b);
    const srcSp = rows.map((r) => r.srcSpreadBps).sort((a, b) => a - b);
    const row = {
      symbol: key,
      samples: rows.length,
      midDevBps: { median: pct(absMid, 50), p95: pct(absMid, 95), p99: pct(absMid, 99), max: absMid[absMid.length - 1] },
      spreadBps: { localMedian: pct(locSp, 50), sourceMedian: pct(srcSp, 50) },
    };
    summary.push(row);
    console.log(
      `  ${key.padEnd(16)} ${pct(absMid, 50).toFixed(2)} / ${pct(absMid, 95).toFixed(2)} / ` +
        `${pct(absMid, 99).toFixed(2)} / ${absMid[absMid.length - 1]!.toFixed(2)}   ·   ` +
        `${pct(locSp, 50).toFixed(1)}/${pct(srcSp, 50).toFixed(1)}`,
    );
  }

  // ---- report: candle fidelity over the run window ----
  const wholeMinutes = Math.floor((Date.now() - startedAt) / 60_000);
  const k = Math.min(Math.max(wholeMinutes - 1, 0), 10);
  const candleReport: Record<string, unknown>[] = [];
  if (k >= 1) {
    console.log(`\n═══ 1m CANDLES — last ${k} completed, local vs source ═══`);
    console.log('  per-candle H/L/C deviation bps (worst of the window) · Σvolume local/source');
    for (const s of specs) {
      try {
        const [loc, src] = await Promise.all([localCandles(s, k + 2), sourceCandles(s, k + 2)]);
        const srcBy = new Map(src.map((c) => [c.openTime, c]));
        const matched = loc
          .filter((c) => c.openTime > startedAt - 60_000 && srcBy.has(c.openTime))
          .slice(-k);
        if (!matched.length) {
          console.log(`  ${s.symbol.padEnd(12)} no overlapping completed candles`);
          continue;
        }
        let worstH = 0, worstL = 0, worstC = 0, volLoc = 0, volSrc = 0;
        for (const c of matched) {
          const r = srcBy.get(c.openTime)!;
          worstH = Math.max(worstH, Math.abs(((c.high - r.high) / r.high) * 1e4));
          worstL = Math.max(worstL, Math.abs(((c.low - r.low) / r.low) * 1e4));
          worstC = Math.max(worstC, Math.abs(((c.close - r.close) / r.close) * 1e4));
          volLoc += c.volume;
          volSrc += r.volume;
        }
        const volRatio = volSrc > 0 ? volLoc / volSrc : NaN;
        candleReport.push({
          symbol: `${s.market}:${s.symbol}`, candles: matched.length,
          worstHighBps: worstH, worstLowBps: worstL, worstCloseBps: worstC, volumeRatio: volRatio,
        });
        console.log(
          `  ${(s.market === 'FUTURES' ? 'F:' : '') + s.symbol}`.padEnd(15) +
            ` H ${worstH.toFixed(2)}  L ${worstL.toFixed(2)}  C ${worstC.toFixed(2)}` +
            `   vol ${(volRatio * 100).toFixed(1)}% of real (${matched.length} candles)`,
        );
      } catch (e) {
        console.log(`  ${s.symbol.padEnd(12)} candle fetch failed: ${(e as Error).message}`);
      }
    }
  }

  if (out) {
    fs.writeFileSync(out, JSON.stringify({ startedAt, minutes, sampleMs, ticks, topOfBook: summary, candles: candleReport }, null, 2));
    log.ok(`wrote ${out}`);
  }
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
