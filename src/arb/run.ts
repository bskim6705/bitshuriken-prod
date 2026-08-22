import { MasterClient, SubaccountClient, exchangeInfo, depth } from '../core/exchange';
import { config } from '../config';
import { makeLogger } from '../core/logger';
import type { DepthSnapshot, SymbolSpec } from '../core/types';
import { TriangleArb, type Triangle } from './triangle';

const log = makeLogger('arb-run');

/** trailing k=v overrides (numbers coerced). */
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
  const coins = String(a.coins ?? 'BTC,ETH,SOL,XRP').split(',').map((s) => s.trim().toUpperCase());
  const mode = (a.mode === 'gross' ? 'gross' : 'edge') as 'edge' | 'gross';
  const quotePerLegKrw = Number(a.quotePerLegKrw ?? 300_000);
  const edgeBufferBps = Number(a.bufferBps ?? 1);
  const pollMs = Number(a.pollMs ?? 400);
  const fundKrw = Number(a.fundKrw ?? 100_000_000);
  const fundUsdt = Number(a.fundUsdt ?? 50_000);
  const durationSec = Number(a.durationSec ?? 0); // 0 = until Ctrl-C

  // --- provision a fresh, isolated account (master → new subaccount, KRW + USDT funded) ---
  const master = new MasterClient();
  await master.ensureAccount(config.master.email, config.master.password);
  const sub = await master.createSubaccount(`arb-triangle-${Date.now()}`);
  log.ok(`subaccount ${sub.id} (taker ${sub.feeTakerBps}bps, maker ${sub.feeMakerBps}bps)`);
  await master.deposit('KRW', String(fundKrw));
  await master.deposit('USDT', String(fundUsdt));
  await master.transfer(master.userId!, sub.id, 'KRW', String(fundKrw), 'SPOT');
  await master.transfer(master.userId!, sub.id, 'USDT', String(fundUsdt), 'SPOT');
  const key = await master.issueApiKey(sub.id, 'arb key');
  const client = new SubaccountClient('arb', key);
  log.ok(`funded ${fundKrw} KRW + ${fundUsdt} USDT, key issued`);

  // --- build the triangles from live exchange-info (skip any coin missing a leg) ---
  const specs = new Map<string, SymbolSpec>();
  for (const s of await exchangeInfo('SPOT')) specs.set(s.symbol, s);
  const fx = specs.get('USDTKRW');
  if (!fx) throw new Error('USDTKRW not listed — cannot run the KRW↔USDT leg');
  const triangles: Triangle[] = [];
  const directByCoin = new Map<string, SymbolSpec>();
  for (const coin of coins) {
    const direct = specs.get(`${coin}KRW`);
    const usd = specs.get(`${coin}USDT`);
    if (!direct || !usd) {
      log.warn(`skip ${coin}: need both ${coin}KRW and ${coin}USDT`);
      continue;
    }
    triangles.push({ coin, direct, usd });
    directByCoin.set(coin, direct);
  }
  if (triangles.length === 0) throw new Error('no tradeable triangles');

  const initialKrw = fundKrw + fundUsdt * mid(await depth('SPOT', fx.symbol, 5));
  const arb = new TriangleArb(client, fx, triangles, { quotePerLegKrw, edgeBufferBps, takerBps: sub.feeTakerBps, pollMs, mode });

  // --- shutdown: stop, mark balances to KRW, report PnL + stats (no forced flatten — residual
  //     inventory is marked at mid so leg risk shows up in the number). ---
  let reported = false;
  const report = async (): Promise<void> => {
    if (reported) return;
    reported = true;
    arb.stop();
    await new Promise((r) => setTimeout(r, 1500)); // let in-flight legs settle
    const fxMid = mid(await depth('SPOT', fx.symbol, 5));
    const bals = await client.balances('SPOT');
    let krwValue = 0;
    const held: Record<string, number> = {};
    for (const b of bals) {
      const amt = Number(b.free) + Number(b.locked);
      if (amt <= 1e-9) continue;
      held[b.asset] = amt;
      if (b.asset === 'KRW') krwValue += amt;
      else if (b.asset === 'USDT') krwValue += amt * fxMid;
      else {
        const spec = directByCoin.get(b.asset);
        if (spec) krwValue += amt * mid(await depth('SPOT', spec.symbol, 5));
      }
    }
    const s = arb.stats();
    log.ok(
      `DONE fires=${s.fires}/${s.attempts} bestSeen=${s.bestBps.toFixed(2)}bps indicativeKrw≈${s.grossKrw.toFixed(0)} | ` +
        `value ${krwValue.toFixed(0)}KRW vs initial ${initialKrw.toFixed(0)}KRW → PnL ${(krwValue - initialKrw).toFixed(0)}KRW`,
    );
    console.error(JSON.stringify({ subaccount: sub.id, stats: s, held, krwValue: Math.round(krwValue), initialKrw: Math.round(initialKrw), pnlKrw: Math.round(krwValue - initialKrw) }, null, 2));
    process.exit(0);
  };
  process.on('SIGINT', () => void report());
  process.on('SIGTERM', () => void report());
  if (durationSec > 0) setTimeout(() => void report(), durationSec * 1000);

  await arb.run();
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
