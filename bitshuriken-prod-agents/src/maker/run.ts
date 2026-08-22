import { MasterClient, SubaccountClient, exchangeInfo, depth } from '../core/exchange';
import { config } from '../config';
import { makeLogger } from '../core/logger';
import type { DepthSnapshot, SymbolSpec } from '../core/types';
import { SpreadMaker } from './maker';

const log = makeLogger('maker-run');

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
  const symbolsArg = String(a.symbols ?? a.symbol ?? 'XRPKRW').split(',').map((s) => s.trim().toUpperCase());
  const quotePerOrderArg = a.quotePerOrder === undefined ? null : Number(a.quotePerOrder);
  const exitMarkupBps = Number(a.exitMarkupBps ?? 0); // 0 → derive from maker fee below
  const slBps = Number(a.slBps ?? 25);
  const pollMs = Number(a.pollMs ?? 500);
  const durationSec = Number(a.durationSec ?? 0);

  const info = new Map<string, SymbolSpec>();
  for (const s of await exchangeInfo('SPOT')) info.set(s.symbol, s);
  const specs: SymbolSpec[] = [];
  for (const sym of symbolsArg) {
    const spec = info.get(sym);
    if (!spec) log.warn(`skip ${sym}: not listed`);
    else specs.push(spec);
  }
  if (specs.length === 0) throw new Error('no tradeable symbols');
  const quoteAsset = specs[0]!.quoteAsset;
  if (!specs.every((s) => s.quoteAsset === quoteAsset)) throw new Error('all symbols must share one quote asset (fund one quote)');
  const fundQuote = Number(a.fundQuote ?? (quoteAsset === 'KRW' ? 100_000_000 : 100_000));
  // 미러 유동성 대비 소액이 기본(≈ $14/주문) — 실제 시장의 비효율은 작고 일시적이라, 큰 주문은
  // 신호가 아니라 미러 재충전 역학을 재는 꼴이 된다 (2026-07-12 유저 지시).
  const quotePerOrder = quotePerOrderArg ?? (quoteAsset === 'KRW' ? 20_000 : 20);

  // --- fresh isolated account, funded in the shared quote ---
  const master = new MasterClient();
  await master.ensureAccount(config.master.email, config.master.password);
  const sub = await master.createSubaccount(`maker-${Date.now()}`);
  log.ok(`subaccount ${sub.id} (maker ${sub.feeMakerBps}bps, taker ${sub.feeTakerBps}bps)`);
  await master.deposit(quoteAsset, String(fundQuote));
  await master.transfer(master.userId!, sub.id, quoteAsset, String(fundQuote), 'SPOT');
  const key = await master.issueApiKey(sub.id, 'maker key');
  const client = new SubaccountClient('maker', key);
  log.ok(`funded ${fundQuote} ${quoteAsset}, key issued`);

  const markup = exitMarkupBps > 0 ? exitMarkupBps : 2 * sub.feeMakerBps + 2; // cover round-trip maker fee + buffer
  const maker = new SpreadMaker(client, specs, { quotePerOrder, exitMarkupBps: markup, slBps, pollMs, makerBps: sub.feeMakerBps });

  let reported = false;
  const report = async (): Promise<void> => {
    if (reported) return;
    reported = true;
    maker.stop();
    for (const s of specs) await client.cancelAll('SPOT', s.symbol).catch(() => {}); // release locks
    await new Promise((r) => setTimeout(r, 1500));
    const bals = await client.balances('SPOT');
    let value = 0;
    const held: Record<string, number> = {};
    for (const b of bals) {
      const amt = Number(b.free) + Number(b.locked);
      if (amt <= 1e-9) continue;
      held[b.asset] = amt;
      if (b.asset === quoteAsset) value += amt;
      else {
        const spec = specs.find((s) => s.baseAsset === b.asset) ?? info.get(`${b.asset}${quoteAsset}`);
        if (spec) value += amt * mid(await depth('SPOT', spec.symbol, 5));
      }
    }
    const s = maker.stats();
    log.ok(`DONE roundTrips=${s.roundTrips} stops=${s.stops} | value ${value.toFixed(2)} ${quoteAsset} vs initial ${fundQuote} → PnL ${(value - fundQuote).toFixed(2)} ${quoteAsset}`);
    console.error(JSON.stringify({ subaccount: sub.id, symbols: symbolsArg, quoteAsset, stats: s, held, value: +value.toFixed(2), initial: fundQuote, pnl: +(value - fundQuote).toFixed(2) }, null, 2));
    process.exit(0);
  };
  process.on('SIGINT', () => void report());
  process.on('SIGTERM', () => void report());
  if (durationSec > 0) setTimeout(() => void report(), durationSec * 1000);

  await maker.run();
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
