import { MasterClient, SubaccountClient, exchangeInfo, depth } from '../core/exchange';
import { config } from '../config';
import { makeLogger } from '../core/logger';
import { floorQty, roundPrice, toFixedStr } from '../core/precision';
import type { Balance, SymbolSpec } from '../core/types';

// Self-cross / wash probe. Two of my own subaccounts trade with EACH OTHER on an empty-book symbol
// (no mirror maker in the way): B rests a SELL, A crosses it. A self-trade must still conserve money
// — the combined (A+B) value may only DROP by the fees paid to the exchange. If the combined value
// stays flat or RISES, the matching/settlement created value on a self-trade = a real bug. Runs on a
// listed-but-unmirrored TRADING symbol so my two orders are the entire book.

const log = makeLogger('probe-xcross');
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

const MIRRORED = new Set(['BTCKRW', 'ETHKRW', 'SOLKRW', 'XRPKRW', 'USDTKRW', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']);

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const forced = a.symbol ? String(a.symbol).toUpperCase() : '';
  const price = Number(a.price ?? 0.5); // self-cross mark (empty book → we set it)
  const qty = Number(a.qty ?? 0); // 0 → derive from minNotional
  const cycles = Number(a.cycles ?? 200);

  const master = new MasterClient();
  await master.ensureAccount(config.master.email, config.master.password);

  const specs = (await exchangeInfo('SPOT')).filter((s) => s.quoteAsset === 'USDT');
  const specBySym = new Map(specs.map((s) => [s.symbol, s] as const));

  // provision A (USDT buyer). We use A to probe which non-mirrored symbol is TRADING (a resting BUY
  // that we then cancel): acceptance means the symbol takes orders and its book is ours to make.
  const aSub = await master.createSubaccount(`xcross-A-${Date.now()}`);
  await master.deposit('USDT', '200000');
  await master.transfer(master.userId!, aSub.id, 'USDT', '200000', 'SPOT');
  const aKey = await master.issueApiKey(aSub.id, 'A key');
  const A = new SubaccountClient('A', aKey);

  const candidates = forced ? [forced] : specs.filter((s) => !MIRRORED.has(s.symbol)).map((s) => s.symbol);
  let spec: SymbolSpec | undefined;
  for (const sym of candidates) {
    const s = specBySym.get(sym);
    if (!s) continue;
    const p = roundPrice(s, price);
    const q = floorQty(s, Math.max(qty, (s.minNotional / Number(p)) * 1.5));
    if (Number(q) <= 0) continue;
    try {
      const o = await A.placeLimit(s, 'BUY', p, q); // rests on an empty book (non-marketable)
      await A.cancel('SPOT', o.id).catch(() => {});
      spec = s;
      log.ok(`using ${sym} (accepts orders; base ${s.baseAsset})`);
      break;
    } catch (e) {
      if (forced) log.warn(`${sym} not tradable`, (e as Error).message);
    }
  }
  if (!spec) throw new Error('no tradable non-mirrored symbol found (self-cross needs an empty book)');

  const P = roundPrice(spec, price);
  const Q = floorQty(spec, qty > 0 ? qty : (spec.minNotional / Number(P)) * 2);
  if (Number(Q) <= 0) throw new Error('qty too small for minNotional');

  // provision B (seller) — fund the base asset + a little USDT for fees.
  const bSub = await master.createSubaccount(`xcross-B-${Date.now()}`);
  const baseFund = Number(Q) * cycles * 1.2 + Number(Q);
  try {
    await master.deposit(spec.baseAsset, toFixedStr(baseFund, spec.qtyPrecision));
  } catch (e) {
    throw new Error(`base ${spec.baseAsset} not depositable: ${(e as Error).message}`);
  }
  await master.deposit('USDT', '50000');
  await master.transfer(master.userId!, bSub.id, spec.baseAsset, toFixedStr(baseFund, spec.qtyPrecision), 'SPOT');
  await master.transfer(master.userId!, bSub.id, 'USDT', '50000', 'SPOT');
  const bKey = await master.issueApiKey(bSub.id, 'B key');
  const B = new SubaccountClient('B', bKey);
  log.ok(`self-crossing ${spec.symbol} @${P} qty ${Q} × ${cycles} cycles`);

  const amt = async (c: SubaccountClient, asset: string): Promise<number> => {
    const bals: Balance[] = await c.balances('SPOT');
    return bals.filter((b) => b.asset === asset).reduce((x, b) => x + Number(b.free) + Number(b.locked), 0);
  };
  // combined value of BOTH accounts, marked at P.
  const combined = async (): Promise<number> => {
    const [au, ab, bu, bb] = await Promise.all([amt(A, 'USDT'), amt(A, spec!.baseAsset), amt(B, 'USDT'), amt(B, spec!.baseAsset)]);
    return au + bu + (ab + bb) * Number(P);
  };

  const start = await combined();
  let fills = 0;
  const done = { v: false };
  const report = async (): Promise<void> => {
    if (done.v) return;
    done.v = true;
    await A.cancelAll('SPOT', spec!.symbol).catch(() => {});
    await B.cancelAll('SPOT', spec!.symbol).catch(() => {});
    await sleep(2000);
    const endv = await combined();
    const delta = endv - start;
    const verdict = delta > 1e-4 ? 'SUSPECT — combined value ROSE on self-trades (verify F1b)' : 'clean — combined value only fell (fees), no money created';
    log.ok(`DONE fills=${fills} combined ${endv.toFixed(4)} vs start ${start.toFixed(4)} → Δ ${delta.toFixed(6)} USDT → ${verdict}`);
    console.error(JSON.stringify({ symbol: spec!.symbol, A: aSub.id, B: bSub.id, fills, startValue: +start.toFixed(4), endValue: +endv.toFixed(4), deltaUsdt: +delta.toFixed(6), verdict }, null, 2));
    process.exit(0);
  };
  process.on('SIGINT', () => void report());

  for (let i = 0; i < cycles; i++) {
    try {
      await B.placeLimit(spec, 'SELL', P, Q); // maker rests on our empty book
      // wait until B's ask is visible in the public book, then A crosses it.
      for (let j = 0; j < 40; j++) {
        const d = await depth('SPOT', spec.symbol, 1);
        if ((d.asks[0]?.[0] ?? Infinity) <= Number(P)) break;
        await sleep(60);
      }
      await A.placeLimit(spec, 'BUY', P, Q); // crosses B → self-trade at P
      await sleep(250); // settle
      fills++;
    } catch (e) {
      log.warn(`cycle ${i} failed`, (e as Error).message);
      await sleep(200);
    }
    if (i > 0 && i % 40 === 0) {
      const v = await combined();
      log.info(`${i} cycles, combined Δ ${(v - start).toFixed(6)} USDT (should be ≤ 0)`);
    }
  }
  await report();
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
