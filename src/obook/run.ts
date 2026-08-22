import { MasterClient, SubaccountClient, exchangeInfo, depth } from '../core/exchange';
import { config } from '../config';
import { makeLogger } from '../core/logger';
import type { DepthSnapshot, SymbolSpec } from '../core/types';
import { ObookTaker } from './taker';

const log = makeLogger('obook-run');

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
  const symbolsArg = String(a.symbols ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map((s) => s.trim().toUpperCase());
  const fundUsdt = Number(a.fundUsdt ?? 200_000);
  const SIGNALS = ['imbalance', 'meanrev', 'rsi', 'emacross', 'momentum'] as const;
  const signal = (SIGNALS.includes(a.signal as (typeof SIGNALS)[number]) ? a.signal : 'imbalance') as (typeof SIGNALS)[number];
  // 미러 유동성 대비 소액이 기본 — 실제 시장의 비효율은 작고 일시적이라, 큰 주문은 신호가 아니라
  // 미러 재충전 역학을 재는 꼴이 된다 (2026-07-12 유저 지시).
  const quotePerTrade = Number(a.quotePerTrade ?? 100);
  const enterImb = Number(a.enterImb ?? 0.15);
  const exitImb = Number(a.exitImb ?? 0);
  const mrDipBps = Number(a.mrDipBps ?? 3);
  const mrWindow = Number(a.mrWindow ?? 60);
  const rsiPeriod = Number(a.rsiPeriod ?? 9);
  const rsiBuy = Number(a.rsiBuy ?? 35);
  const rsiSell = Number(a.rsiSell ?? 65);
  const emaFast = Number(a.emaFast ?? 5);
  const emaSlow = Number(a.emaSlow ?? 20);
  const momTicks = Number(a.momTicks ?? 5);
  const momBps = Number(a.momBps ?? 1);
  const tpBps = Number(a.tpBps ?? 2);
  const slBps = Number(a.slBps ?? 4);
  const depthLevels = Number(a.depthLevels ?? 10);
  const pollMs = Number(a.pollMs ?? 300);
  const durationSec = Number(a.durationSec ?? 0);

  // --- fresh isolated account, funded in USDT (the quote of the traded pairs) ---
  const master = new MasterClient();
  await master.ensureAccount(config.master.email, config.master.password);
  const sub = await master.createSubaccount(`obook-${Date.now()}`);
  log.ok(`subaccount ${sub.id} (taker ${sub.feeTakerBps}bps)`);
  await master.deposit('USDT', String(fundUsdt));
  await master.transfer(master.userId!, sub.id, 'USDT', String(fundUsdt), 'SPOT');
  const key = await master.issueApiKey(sub.id, 'obook key');
  const client = new SubaccountClient('obook', key);
  log.ok(`funded ${fundUsdt} USDT, key issued`);

  const info = new Map<string, SymbolSpec>();
  for (const s of await exchangeInfo('SPOT')) info.set(s.symbol, s);
  const specs: SymbolSpec[] = [];
  for (const sym of symbolsArg) {
    const spec = info.get(sym);
    if (!spec) {
      log.warn(`skip ${sym}: not listed`);
      continue;
    }
    if (spec.quoteAsset !== 'USDT') {
      log.warn(`skip ${sym}: quote ${spec.quoteAsset} ≠ USDT (fund that quote to trade it)`);
      continue;
    }
    specs.push(spec);
  }
  if (specs.length === 0) throw new Error('no tradeable USDT symbols');

  const taker = new ObookTaker(client, specs, {
    signal,
    quotePerTrade,
    enterImb,
    exitImb,
    mrDipBps,
    mrWindow,
    rsiPeriod,
    rsiBuy,
    rsiSell,
    emaFast,
    emaSlow,
    momTicks,
    momBps,
    tpBps,
    slBps,
    depthLevels,
    pollMs,
    takerBps: sub.feeTakerBps,
  });

  let reported = false;
  const report = async (): Promise<void> => {
    if (reported) return;
    reported = true;
    taker.stop();
    await new Promise((r) => setTimeout(r, 1200));
    const bals = await client.balances('SPOT');
    let usdtValue = 0;
    const held: Record<string, number> = {};
    for (const b of bals) {
      const amt = Number(b.free) + Number(b.locked);
      if (amt <= 1e-9) continue;
      held[b.asset] = amt;
      if (b.asset === 'USDT') usdtValue += amt;
      else {
        const spec = info.get(`${b.asset}USDT`);
        if (spec) usdtValue += amt * mid(await depth('SPOT', spec.symbol, 5));
      }
    }
    const s = taker.stats();
    log.ok(
      `DONE trades=${s.trades} realized≈${s.realizedQuote.toFixed(2)}USDT | value ${usdtValue.toFixed(2)}USDT vs initial ${fundUsdt} → PnL ${(usdtValue - fundUsdt).toFixed(2)}USDT`,
    );
    console.error(JSON.stringify({ subaccount: sub.id, stats: s, held, usdtValue: +usdtValue.toFixed(2), initialUsdt: fundUsdt, pnlUsdt: +(usdtValue - fundUsdt).toFixed(2) }, null, 2));
    process.exit(0);
  };
  process.on('SIGINT', () => void report());
  process.on('SIGTERM', () => void report());
  if (durationSec > 0) setTimeout(() => void report(), durationSec * 1000);

  await taker.run();
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
