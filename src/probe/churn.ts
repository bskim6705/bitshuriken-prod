import { MasterClient, SubaccountClient, exchangeInfo, depth } from '../core/exchange';
import { config } from '../config';
import { makeLogger } from '../core/logger';
import { floorQty, roundPrice } from '../core/precision';
import type { Balance, DepthSnapshot, LocalOrder, SymbolSpec } from '../core/types';

// Lock-accounting probe. Rapidly place resting BUY limits far below market (they never fill, only
// lock quote) and cancel them immediately — hammering the place↔cancel race in the partition
// (refactor-observations #12/#17). A correct exchange always releases the lock on cancel, so after a
// final cancel-all + drain the account's FREE quote must equal what was funded, with zero open
// orders. Stuck locks (free < funded) or a broken F4 (locked ≠ Σ open orders) = a real bug.

const log = makeLogger('probe-churn');
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

const bestBid = (d: DepthSnapshot): number => d.bids[0]?.[0] ?? 0;

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const symbols = String(a.symbols ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map((s) => s.trim().toUpperCase());
  const fundUsdt = Number(a.fundUsdt ?? 500_000);
  const quotePerOrder = Number(a.quotePerOrder ?? 300);
  const farPct = Number(a.farPct ?? 0.3); // rest this far below market so it never fills
  const durationSec = Number(a.durationSec ?? 150);

  const master = new MasterClient();
  await master.ensureAccount(config.master.email, config.master.password);
  const sub = await master.createSubaccount(`probe-churn-${Date.now()}`);
  await master.deposit('USDT', String(fundUsdt));
  await master.transfer(master.userId!, sub.id, 'USDT', String(fundUsdt), 'SPOT');
  const key = await master.issueApiKey(sub.id, 'churn key');
  const client = new SubaccountClient('churn', key);

  const info = new Map<string, SymbolSpec>();
  for (const s of await exchangeInfo('SPOT')) info.set(s.symbol, s);
  const specs = symbols.map((s) => info.get(s)).filter((s): s is SymbolSpec => !!s && s.quoteAsset === 'USDT');
  if (!specs.length) throw new Error('no USDT symbols');
  log.ok(`subaccount ${sub.id} funded ${fundUsdt} USDT, churning ${specs.map((s) => s.symbol).join(',')}`);

  const freeUsdt = async (): Promise<number> => {
    const bals: Balance[] = await client.balances('SPOT');
    return bals.filter((b) => b.asset === 'USDT').reduce((x, b) => x + Number(b.free), 0);
  };

  let placed = 0;
  let canceled = 0;
  let placeErr = 0;
  let cancelErr = 0;

  // one tight place→cancel race on a symbol: place a resting BUY, then immediately cancel that id.
  // Price is cached (a far-below resting order barely moves) so we don't spam depth — the point is
  // to maximize place/cancel throughput through the engine partition, not to re-read the book.
  const raceOnce = async (spec: SymbolSpec, price: string | undefined): Promise<void> => {
    if (!price || Number(price) <= 0) return;
    const qty = floorQty(spec, quotePerOrder / Number(price));
    if (Number(qty) <= 0) return;
    let order: LocalOrder | null = null;
    try {
      order = await client.placeLimit(spec, 'BUY', price, qty);
      placed++;
    } catch (e) {
      placeErr++;
      if (placeErr <= 3) log.warn(`${spec.symbol} place @${price} rejected`, (e as Error).message);
      return;
    }
    try {
      await client.cancel('SPOT', order.id);
      canceled++;
    } catch {
      cancelErr++; // cancel lost the race (engine hadn't seen the order) — the leak surface
    }
  };

  const done = { v: false };
  const finish = async (): Promise<void> => {
    if (done.v) return;
    done.v = true;
    // final safety cancel-all, then drain and verify every lock was released.
    for (const spec of specs) await client.cancelAll('SPOT', spec.symbol).catch(() => {});
    await sleep(2500);
    let openLeft = 0;
    for (const spec of specs) openLeft += (await client.openOrders('SPOT', spec.symbol).catch(() => [])).length;
    const free = await freeUsdt();
    const stuck = fundUsdt - free; // quote still locked after all cancels (should be ~0)
    const leak = Math.abs(stuck) > 1e-6 || openLeft > 0;
    const verdict = leak ? 'SUSPECT — locks not fully released / orders survived cancel (verify F4)' : 'clean — every lock released, no orders survived';
    log.ok(`DONE placed=${placed} canceled=${canceled} placeErr=${placeErr} cancelErr=${cancelErr} openLeft=${openLeft} freeUSDT=${free.toFixed(6)}/${fundUsdt} stuck=${stuck.toFixed(6)} → ${verdict}`);
    console.error(JSON.stringify({ subaccount: sub.id, placed, canceled, placeErr, cancelErr, openLeft, freeUsdt: +free.toFixed(6), fundedUsdt: fundUsdt, stuckUsdt: +stuck.toFixed(6), verdict }, null, 2));
    process.exit(0);
  };
  process.on('SIGINT', () => void finish());

  const px = new Map<string, string>(); // cached far-below resting price per symbol
  const end = Date.now() + durationSec * 1000;
  let iter = 0;
  while (Date.now() < end) {
    if (iter % 25 === 0) {
      for (const spec of specs) {
        const bb = bestBid(await depth('SPOT', spec.symbol, 1));
        if (bb > 0) px.set(spec.symbol, roundPrice(spec, bb * (1 - farPct)));
      }
    }
    await Promise.all(specs.map((s) => raceOnce(s, px.get(s.symbol)))); // hammer all symbols concurrently
    iter++;
  }
  await finish();
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
