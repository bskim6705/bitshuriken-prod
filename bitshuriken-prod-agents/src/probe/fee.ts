import { MasterClient, SubaccountClient, exchangeInfo, depth } from '../core/exchange';
import { config } from '../config';
import { makeLogger } from '../core/logger';
import { toFixedStr } from '../core/precision';
import type { AccountTrade, DepthSnapshot, SymbolSpec } from '../core/types';

// Fee-rounding probe. The classic exploit: if the taker fee is floor()'d in some unit, a trade small
// enough makes the fee round to ZERO — free taker fills, and a maker scalper at that size profits.
// We fire MARKET BUYs at the smallest allowed notional and read each fill's commission from the
// ledger; the effective fee (commission valued in quote ÷ notional) must stay ≈ the account's taker
// bps. An effective fee ≈ 0 (or ≪ nominal) on a nonzero notional = money the exchange fails to
// charge = a real economic bug.

const log = makeLogger('probe-fee');
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
  const symbols = String(a.symbols ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map((s) => s.trim().toUpperCase());
  const perSize = Number(a.perSize ?? 8); // trades per notional bucket per symbol

  const master = new MasterClient();
  await master.ensureAccount(config.master.email, config.master.password);
  const sub = await master.createSubaccount(`probe-fee-${Date.now()}`);
  await master.deposit('USDT', '200000');
  await master.transfer(master.userId!, sub.id, 'USDT', '200000', 'SPOT');
  const key = await master.issueApiKey(sub.id, 'fee key');
  const client = new SubaccountClient('fee', key);
  const takerBps = sub.feeTakerBps;

  const info = new Map<string, SymbolSpec>();
  for (const s of await exchangeInfo('SPOT')) info.set(s.symbol, s);
  const specs = symbols.map((s) => info.get(s)).filter((s): s is SymbolSpec => !!s && s.quoteAsset === 'USDT');
  log.ok(`subaccount ${sub.id} taker=${takerBps}bps — probing fee rounding at minNotional`);

  const feeInQuote = (t: AccountTrade, price: number, baseAsset: string): number => {
    const c = Number(t.commission);
    return t.commissionAsset === baseAsset ? c * price : c; // base-denominated fee → value in quote
  };

  let flagged = 0;
  const rows: { symbol: string; notional: number; feeQuote: number; effBps: number }[] = [];

  for (const spec of specs) {
    const price = mid(await depth('SPOT', spec.symbol, 1));
    if (!price) continue;
    // notional buckets from exactly minNotional upward — where floored fees are most likely to vanish.
    const buckets = [spec.minNotional, spec.minNotional * 1.01, spec.minNotional * 1.5, spec.minNotional * 3];
    for (const notional of buckets) {
      for (let i = 0; i < perSize; i++) {
        const q = notional + i * (spec.minNotional * 0.001); // jitter to hit varied floor remainders
        const before = Date.now() - 1;
        try {
          await client.placeMarket(spec, 'BUY', '0', toFixedStr(q, spec.pricePrecision));
        } catch {
          continue;
        }
        await sleep(220); // settle
        const trades = await client.trades('SPOT', { symbol: spec.symbol, limit: 10 });
        const fresh = trades.filter((t) => t.time >= before && t.isBuyer);
        for (const t of fresh) {
          const notionalQ = Number(t.quoteQty);
          const fq = feeInQuote(t, Number(t.price), spec.baseAsset);
          const effBps = notionalQ > 0 ? (fq / notionalQ) * 1e4 : 0;
          rows.push({ symbol: spec.symbol, notional: notionalQ, feeQuote: fq, effBps });
          if (notionalQ > 0 && effBps < takerBps * 0.5) {
            flagged++;
            log.err(`UNDERCHARGE ${spec.symbol} notional=${notionalQ.toFixed(4)} fee=${fq.toFixed(8)} eff=${effBps.toFixed(3)}bps (nominal ${takerBps})`);
          }
        }
        // sell back to stay roughly flat (ignore result — this probe only cares about the buy fee)
        const bals = await client.balances('SPOT');
        const base = bals.filter((b) => b.asset === spec.baseAsset).reduce((x, b) => x + Number(b.free), 0);
        if (base > spec.stepSize) await client.placeMarket(spec, 'SELL', toFixedStr(Math.floor(base / spec.stepSize) * spec.stepSize, spec.qtyPrecision), '0').catch(() => {});
        await sleep(150);
      }
    }
  }

  const withFee = rows.filter((r) => r.notional > 0);
  const minEff = withFee.length ? Math.min(...withFee.map((r) => r.effBps)) : NaN;
  const zeroFee = withFee.filter((r) => r.feeQuote <= 0).length;
  const verdict = flagged > 0 ? 'SUSPECT — taker fee undercharged on small trades (verify economics)' : 'clean — fee ≈ nominal on every trade, no rounding-to-zero';
  log.ok(`DONE fills=${withFee.length} zeroFee=${zeroFee} minEffBps=${minEff.toFixed(3)} nominal=${takerBps}bps flagged=${flagged} → ${verdict}`);
  console.error(JSON.stringify({ subaccount: sub.id, takerBps, fills: withFee.length, zeroFeeFills: zeroFee, minEffectiveBps: +minEff.toFixed(3), flagged, verdict }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
