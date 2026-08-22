import { MasterClient, SubaccountClient, exchangeInfo, depth } from '../core/exchange';
import { config } from '../config';
import { makeLogger } from '../core/logger';
import { floorQty, toFixedStr } from '../core/precision';
import type { Balance, DepthSnapshot, SymbolSpec } from '../core/types';

// Money-creation probe. A correct exchange makes every MARKET buy→sell round trip LOSE (taker fee
// twice + spread); the quote-driven MARKET BUY floors to stepSize and refunds the unspent quote as
// dust. We hammer that path with adversarial quote amounts and measure each round trip's TOTAL value
// (USDT + base×mid) at full settlement quiesce. Every delta MUST be < 0. A delta ≥ 0 means value was
// created (dust over-refund / fee under-charge / favorable floor) = a real bug. Single symbol + a
// settle-quiesce between legs makes the measurement immune to async-settlement timing (balance
// snapshots across interleaved symbols are NOT reliable — that yields false positives).

const log = makeLogger('probe-prec');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseArgs(args: string[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const a of args) {
    const [k, v] = a.split('=');
    if (!k || v === undefined) continue;
    const n = Number(v);
    out[k] = Number.isFinite(n) && v.trim() !== '' ? n : v;
  }
  return out;
}

const mid = (d: DepthSnapshot): number => {
  const b = d.bids[0]?.[0] ?? 0;
  const a = d.asks[0]?.[0] ?? 0;
  return b && a ? (b + a) / 2 : b || a;
};

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const symbol = String(a.symbol ?? 'BTCUSDT').toUpperCase();
  const fundUsdt = Number(a.fundUsdt ?? 200_000);
  const baseQuote = Number(a.baseQuote ?? 120);
  const durationSec = Number(a.durationSec ?? 180);

  const master = new MasterClient();
  await master.ensureAccount(config.master.email, config.master.password);
  const sub = await master.createSubaccount(`probe-prec-${symbol}-${Date.now()}`);
  await master.deposit('USDT', String(fundUsdt));
  await master.transfer(master.userId!, sub.id, 'USDT', String(fundUsdt), 'SPOT');
  const key = await master.issueApiKey(sub.id, 'probe key');
  const client = new SubaccountClient('probe', key);

  const info = new Map<string, SymbolSpec>();
  for (const s of await exchangeInfo('SPOT')) info.set(s.symbol, s);
  const spec = info.get(symbol);
  if (!spec || spec.quoteAsset !== 'USDT') throw new Error(`${symbol} not a USDT symbol`);
  log.ok(`${symbol} subaccount ${sub.id} taker=${sub.feeTakerBps}bps funded ${fundUsdt} USDT`);

  const bal = async (asset: string): Promise<number> => {
    const bals: Balance[] = await client.balances('SPOT');
    return bals.filter((b) => b.asset === asset).reduce((x, b) => x + Number(b.free) + Number(b.locked), 0);
  };
  // value = USDT + base×mid, read only once the balances are STABLE (two equal reads = settled).
  const quiescedValue = async (): Promise<number> => {
    let prevU = NaN;
    let prevB = NaN;
    for (let i = 0; i < 60; i++) {
      const u = await bal('USDT');
      const b = await bal(spec.baseAsset);
      if (u === prevU && b === prevB) {
        return u + b * mid(await depth('SPOT', symbol, 1));
      }
      prevU = u;
      prevB = b;
      await sleep(120);
    }
    return prevU + prevB * mid(await depth('SPOT', symbol, 1));
  };

  let cycles = 0;
  let anomalies = 0;
  let worst = -Infinity;
  let totalDelta = 0;
  let prev = await quiescedValue();
  const start = prev;

  const done = { v: false };
  const report = (): void => {
    if (done.v) return;
    done.v = true;
    // Only the NET settled delta over many cycles is reliable (per-cycle deltas are async-timing
    // noise). Money is created only if the account ends up ahead: net ≥ 0. F1b is the final word.
    const net = prev - start;
    const verdict = net >= 0 ? 'SUSPECT — net ≥ 0 over the run, verify with F1b' : 'clean — net loss to fees (no money created)';
    log.ok(`DONE ${symbol} cycles=${cycles} gainCycles(>1¢)=${anomalies} worstΔ=${worst.toFixed(6)} netΔ=${net.toFixed(4)} USDT → ${verdict}`);
    console.error(JSON.stringify({ symbol, subaccount: sub.id, cycles, gainCycles: anomalies, worstDeltaUsdt: +worst.toFixed(6), netDeltaUsdt: +net.toFixed(4), verdict }, null, 2));
    process.exit(0);
  };
  process.on('SIGINT', report);
  const end = Date.now() + durationSec * 1000;

  while (Date.now() < end) {
    const price = mid(await depth('SPOT', symbol, 1));
    if (!price) {
      await sleep(200);
      continue;
    }
    // adversarial quote: odd fraction + sub-cent, cycling small→large to vary the floored dust.
    const q = baseQuote * (1 + (cycles % 5) * 0.41) + (cycles % 7) * 0.013 + 0.007;
    if (q < spec.minNotional) {
      cycles++;
      continue;
    }
    try {
      await client.placeMarket(spec, 'BUY', '0', toFixedStr(q, spec.pricePrecision));
    } catch {
      await sleep(150);
      continue;
    }
    // wait for the buy to settle, then sell all base back.
    for (let i = 0; i < 50; i++) {
      if ((await bal(spec.baseAsset)) > spec.stepSize) break;
      await sleep(80);
    }
    const held = await bal(spec.baseAsset);
    const sellQty = floorQty(spec, held);
    if (Number(sellQty) > 0) {
      try {
        await client.placeMarket(spec, 'SELL', sellQty, '0');
      } catch {
        /* leave residual; valued at quiesce */
      }
    }
    const val = await quiescedValue();
    const delta = val - prev;
    prev = val;
    cycles++;
    totalDelta += delta;
    if (delta > worst) worst = delta;
    if (delta > 0.01) {
      // a clear (>1¢) single-cycle gain — well above float/timing noise. Worth surfacing; the net + F1b decide.
      anomalies++;
      log.err(`GAIN ${symbol} cycle#${cycles} Δ=+${delta.toFixed(6)} USDT (q=${q.toFixed(3)})`);
    } else if (cycles % 20 === 0) {
      log.info(`${symbol} ${cycles} cycles worstΔ=${worst.toFixed(6)} netΔ=${(prev - start).toFixed(3)} (losing — healthy)`);
    }
  }
  report();
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
