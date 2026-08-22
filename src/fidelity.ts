import ccxt from 'ccxt';
import { apiBase } from './config';
import { makeLogger } from './log';

// Mirror-fidelity probe — OBSERVATION ONLY (no orders). For every mirrored spot symbol it compares
// the LOCAL exchange book against the REAL source book (Binance for USDT, Upbit for KRW) on three
// axes — mid, spread, depth — and checks whether the local kimchi premium matches the real one.
// "실제 시장과의 유사성" 검증. Read-only; safe to run alongside the mirror bots.

const log = makeLogger('fidelity');
const N = 10; // levels summed for the depth-notional comparison

const binance = new ccxt.binance({ enableRateLimit: true });
const upbit = new ccxt.upbit({ enableRateLimit: true });

interface Level {
  p: number;
  q: number;
}
interface Book {
  bids: Level[];
  asks: Level[];
}
interface Spec {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}

const mid = (b: Book): number => (b.bids[0]!.p + b.asks[0]!.p) / 2;
const spreadBps = (b: Book): number => ((b.asks[0]!.p - b.bids[0]!.p) / mid(b)) * 1e4;
const depthNotional = (b: Book): number => {
  const side = (ls: Level[]): number => ls.slice(0, N).reduce((s, l) => s + l.p * l.q, 0);
  return side(b.bids) + side(b.asks);
};
const usable = (b: Book | null): b is Book => !!b && b.bids.length > 0 && b.asks.length > 0;

async function localBook(symbol: string): Promise<Book | null> {
  const res = await fetch(`${apiBase('SPOT')}/spot/market/depth?symbol=${symbol}&limit=${N + 5}`);
  if (!res.ok) return null;
  const env = (await res.json()) as { data: { bids: [string, string][]; asks: [string, string][] } };
  const map = (l: [string, string][]): Level[] => l.map(([p, q]) => ({ p: Number(p), q: Number(q) }));
  return { bids: map(env.data.bids), asks: map(env.data.asks) };
}

async function sourceBook(spec: Spec): Promise<Book | null> {
  const ex = spec.quoteAsset === 'KRW' ? upbit : binance;
  const ob = await ex.fetchOrderBook(`${spec.baseAsset}/${spec.quoteAsset}`, N + 5).catch(() => null);
  if (!ob) return null;
  const map = (l: [number, number][]): Level[] => l.filter((x) => x[0] != null && x[1] != null).map(([p, q]) => ({ p, q }));
  return { bids: map(ob.bids as [number, number][]), asks: map(ob.asks as [number, number][]) };
}

async function exchangeInfo(): Promise<Spec[]> {
  const res = await fetch(`${apiBase('SPOT')}/spot/market/exchange-info`);
  const env = (await res.json()) as { data: { symbols: Spec[] } };
  return env.data.symbols.map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }));
}

const localMids = new Map<string, number>();
const srcMids = new Map<string, number>();

async function once(): Promise<void> {
  // per-cycle state: --watch must not compute kimchi off a previous cycle's stale mids
  localMids.clear();
  srcMids.clear();
  const specs = await exchangeInfo();
  console.log(`\n═══ mirror fidelity — ${new Date().toTimeString().slice(0, 8)} ═══`);
  console.log('  local vs REAL source book (mid drift / spread / depth-notional over top ' + N + ')');

  const rows: { sym: string; drift: number; locSp: number; srcSp: number; depthR: number }[] = [];
  for (const spec of specs) {
    const [loc, src] = await Promise.all([localBook(spec.symbol).catch(() => null), sourceBook(spec)]);
    if (!usable(loc)) continue; // not mirrored
    localMids.set(spec.symbol, mid(loc));
    if (!usable(src)) {
      console.log(`  ${spec.symbol.padEnd(9)} local ${mid(loc).toFixed(2)} (source unreachable)`);
      continue;
    }
    srcMids.set(spec.symbol, mid(src));
    const drift = ((mid(loc) - mid(src)) / mid(src)) * 1e4;
    const locSp = spreadBps(loc);
    const srcSp = spreadBps(src);
    const depthR = depthNotional(loc) / (depthNotional(src) || 1);
    rows.push({ sym: spec.symbol, drift, locSp, srcSp, depthR });
    console.log(
      `  ${spec.symbol.padEnd(9)} mid ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}bps  ` +
        `spread ${locSp.toFixed(1)}/${srcSp.toFixed(1)}bps (loc/real)  depth ${(depthR * 100).toFixed(0)}% of real`,
    );
  }

  if (rows.length) {
    const avg = (f: (r: (typeof rows)[0]) => number): number => rows.reduce((s, r) => s + f(r), 0) / rows.length;
    const avgAbsDrift = rows.reduce((s, r) => s + Math.abs(r.drift), 0) / rows.length;
    console.log(
      `  ── avg |mid drift| ${avgAbsDrift.toFixed(1)}bps · spread ${avg((r) => r.locSp).toFixed(1)}/${avg((r) => r.srcSp).toFixed(1)}bps · depth ${(avg((r) => r.depthR) * 100).toFixed(0)}% of real`,
    );
  }

  // --- kimchi premium: local internal vs real-world (Upbit vs Binance) ---
  const locFx = localMids.get('USDTKRW');
  const realFx = srcMids.get('USDTKRW');
  const krwCoins = specs.filter((s) => s.quoteAsset === 'KRW' && s.baseAsset !== 'USDT');
  if (locFx && realFx && krwCoins.length) {
    console.log('  KIMCHI PREMIUM  local(internal) vs real(Upbit÷Binance):');
    for (const k of krwCoins) {
      const locKrw = localMids.get(k.symbol);
      const locUsdt = localMids.get(`${k.baseAsset}USDT`);
      const realKrw = srcMids.get(k.symbol);
      const realUsdt = srcMids.get(`${k.baseAsset}USDT`);
      if (!locKrw || !locUsdt || !realKrw || !realUsdt) continue;
      const locPrem = locKrw / (locUsdt * locFx) - 1;
      const realPrem = realKrw / (realUsdt * realFx) - 1;
      console.log(
        `    ${k.baseAsset.padEnd(4)} local ${(locPrem * 100).toFixed(3)}%  real ${(realPrem * 100).toFixed(3)}%  ` +
          `Δ ${((locPrem - realPrem) * 1e4).toFixed(1)}bps`,
      );
    }
  }
}

async function main(): Promise<void> {
  const watch = process.argv.includes('--watch');
  if (!watch) return void (await once());
  log.info('fidelity every 5s (Ctrl-C to stop)');
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
