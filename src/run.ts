import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { LocalExchangeClient, type ApiKeyPair } from './exchange';
import { buildFeeds } from './feeds';
import { MakerBot } from './bots/maker';
import { TakerBot } from './bots/taker';
import { makeLogger } from './log';
import type { Feed, Market, SymbolSpec } from './types';

const log = makeLogger('run');

// dev mint TARGETS per bot account. Funding is idempotent: each boot (and the periodic refill
// loop) reads the account's balance and tops up only the shortfall below half the target —
// a restart no longer re-mints the full amount on top of what the account already holds.
const QUOTE_TARGET: Record<string, number> = {
  USDT: 100_000_000, // 100M
  USDC: 100_000_000,
  KRW: 100_000_000_000, // 100B (≈ 100M USD worth)
};
const DEFAULT_QUOTE_TARGET = 100_000_000;
const BASE_TARGET_FLOOR = 100_000; // floor units of each base (cheap/unlisted bases)
const BASE_NOTIONAL = 2_000_000; // target ~$2M worth of each base, so sub-cent alts get enough units
const FUTURES_MARGIN = 10_000_000; // 10M USDT kept in the futures wallet of a futures account
const REFILL_EVERY_MS = 10 * 60_000; // periodic top-up absorbs fee bleed / one-sided fills
const BOOTSTRAP_CONCURRENCY = 4; // parallel account bootstraps (portal is single-event-loop too)

// One account per (role, market, symbol) — ADR-070. Two shared accounts serialized every
// symbol's freeze/settle/refund on a couple of hot rows and skewed latency measurements.
const accountEmail = (role: 'maker' | 'taker', spec: SymbolSpec): string =>
  `${role}-${spec.market === 'FUTURES' ? 'f-' : ''}${spec.symbol.toLowerCase()}@bots.local`;

// Sub-cent alts (VANRY ~$0.0065) need far more than a flat 100k base to mirror one Binance ask
// level. Fund each base to a notional target via its public Binance price; fall back to the flat
// floor for unlisted bases / lookup failure. KRW-market bases use the USDT price too (value-approx).
const baseTargetCache = new Map<string, number>();
async function baseTarget(base: string): Promise<number> {
  const cached = baseTargetCache.get(base);
  if (cached) return cached;
  let qty = BASE_TARGET_FLOOR;
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${base}USDT`);
    const j = (await res.json()) as { bidPrice?: string; askPrice?: string };
    const price = (Number(j.bidPrice) + Number(j.askPrice)) / 2;
    if (price > 0) qty = Math.max(BASE_TARGET_FLOOR, Math.ceil(BASE_NOTIONAL / price));
  } catch {
    /* unlisted base or network error — keep the flat floor */
  }
  baseTargetCache.set(base, qty);
  return qty;
}

async function resolveWanted(client: LocalExchangeClient): Promise<SymbolSpec[]> {
  if (config.symbols.length === 0) {
    const out: SymbolSpec[] = [];
    for (const market of ['SPOT', 'FUTURES'] as Market[]) {
      try {
        out.push(...(await client.exchangeInfo(market)));
      } catch (e) {
        log.warn(`${market} exchange-info unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    log.ok(`discovered ${out.length} listed tickers from the exchange`);
    return out;
  }
  const byKey = new Map<string, SymbolSpec>();
  for (const market of ['SPOT', 'FUTURES'] as Market[]) {
    if (!config.symbols.some((s) => s.market === market)) continue;
    for (const spec of await client.exchangeInfo(market)) byKey.set(`${market}:${spec.symbol}`, spec);
  }
  return config.symbols
    .map((s) => byKey.get(`${s.market}:${s.symbol}`))
    .filter((s): s is SymbolSpec => {
      if (!s) log.warn('skipping configured symbol not found on local exchange');
      return Boolean(s);
    });
}

/** free+locked of one asset in a balance list. */
function held(balances: { asset: string; free: string; locked: string }[], asset: string): number {
  const b = balances.find((x) => x.asset === asset);
  return b ? Number(b.free) + Number(b.locked) : 0;
}

/**
 * Idempotent funding for ONE account mirroring ONE symbol: top an asset up to its target only
 * when the account holds less than half of it. Ran at boot and by the refill loop (fees bleed
 * both accounts ~10bps per fill; trends drain one side of the maker's inventory).
 */
async function ensureFunded(client: LocalExchangeClient, spec: SymbolSpec): Promise<void> {
  const spot = await client.balances('SPOT');
  const topUp = async (asset: string, target: number): Promise<void> => {
    const have = held(spot, asset);
    if (have >= target / 2) return;
    await client.deposit(asset, String(Math.ceil(target - have)));
  };
  const quoteAsset = spec.market === 'FUTURES' ? 'USDT' : spec.quoteAsset;
  await topUp(quoteAsset, QUOTE_TARGET[quoteAsset] ?? DEFAULT_QUOTE_TARGET);
  if (spec.market === 'SPOT' && spec.baseAsset !== spec.quoteAsset) {
    await topUp(spec.baseAsset, await baseTarget(spec.baseAsset));
  }
  if (spec.market === 'FUTURES') {
    const fut = await client.balances('FUTURES');
    const have = held(fut, 'USDT');
    if (have < FUTURES_MARGIN / 2) {
      await client.transfer('SPOT', 'FUTURES', 'USDT', String(Math.ceil(FUTURES_MARGIN - have)));
    }
  }
}

// ---- persisted API keys: the portal mints a new key per request, so reuse across boots ----
const KEY_STORE = path.join(process.cwd(), '.bot-keys.json');

function loadKeyStore(): Record<string, ApiKeyPair> {
  try {
    return JSON.parse(fs.readFileSync(KEY_STORE, 'utf8')) as Record<string, ApiKeyPair>;
  } catch {
    return {};
  }
}

function saveKeyStore(store: Record<string, ApiKeyPair>): void {
  fs.writeFileSync(KEY_STORE, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

async function bootstrap(
  client: LocalExchangeClient,
  email: string,
  keyStore: Record<string, ApiKeyPair>,
): Promise<void> {
  await client.ensureAccount(email, config.accounts.password);
  const cached = keyStore[email];
  let reused = false;
  if (cached) {
    client.setApiKey(cached);
    reused = await client.keyWorks();
  }
  if (!reused) {
    await client.ensureApiKey();
    keyStore[email] = client.getApiKey()!;
  }
  if (config.adminSecret) {
    await client.ensureRateLimitExempt(config.adminSecret);
  }
}

/** run `fn` over items with a bounded number in flight. */
async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  });
  await Promise.all(workers);
}

async function main(): Promise<void> {
  const probe = new LocalExchangeClient('probe'); // public reads only (exchange-info)
  const wanted = await resolveWanted(probe);
  if (wanted.length === 0)
    throw new Error('nothing to mirror — exchange listed no tickers (and no *_SYMBOLS override)');

  // one maker + one taker account per spec
  const keyStore = loadKeyStore();
  const clients = new Map<string, { maker: LocalExchangeClient; taker: LocalExchangeClient; spec: SymbolSpec }>();
  for (const spec of wanted) {
    const key = `${spec.market}:${spec.symbol}`;
    clients.set(key, {
      maker: new LocalExchangeClient(`maker:${key}`),
      taker: new LocalExchangeClient(`taker:${key}`),
      spec,
    });
  }
  await pooled([...clients.values()], BOOTSTRAP_CONCURRENCY, async ({ maker, taker, spec }) => {
    await bootstrap(maker, accountEmail('maker', spec), keyStore);
    await bootstrap(taker, accountEmail('taker', spec), keyStore);
    await ensureFunded(maker, spec);
    await ensureFunded(taker, spec);
    if (spec.market === 'FUTURES') {
      for (const c of [maker, taker]) {
        await c.setLeverage(spec.symbol, config.tuning.futuresLeverage).catch((e: unknown) => {
          log.warn(`${c.label}: setLeverage failed — futures orders may be margin-rejected`, (e as Error).message);
        });
      }
    }
  });
  saveKeyStore(keyStore);
  if (!config.adminSecret) {
    log.warn('no ADMIN_API_SECRET — accounts not rate-limit exempt (ok only while RATE_LIMIT_ENABLED=false)');
  }
  log.ok(`accounts ready — ${clients.size} maker/taker pairs (one per symbol)`);

  const makers = new Map<string, MakerBot>();
  const takers = new Map<string, TakerBot>();
  for (const [key, { maker, taker, spec }] of clients) {
    makers.set(
      key,
      new MakerBot(
        maker,
        spec,
        config.tuning.depthLevels,
        config.tuning.reconcileMs,
        config.tuning.futuresMaxNotional,
        config.tuning.qtyTolerance,
        config.tuning.resyncMs,
        config.tuning.passOpsCap,
      ),
    );
    takers.set(key, new TakerBot(taker, spec, config.tuning.takerMaxQtyFrac, config.tuning.takerMaxTps));
  }

  // one feed per (source, market): Binance for USDT/USDC, Upbit for KRW.
  const feeds: Feed[] = [];
  for (const { feed, specs } of buildFeeds(wanted, config.tuning.depthLevels)) {
    const market = feed.market;
    feed.onDepth((symbol, depth) => makers.get(`${market}:${symbol}`)?.onDepth(depth));
    feed.onTrade((symbol, trade) => takers.get(`${market}:${symbol}`)?.onTrade(trade));
    feed.start();
    feeds.push(feed);
    log.ok(`feed up: ${specs.length} symbols`);
  }

  for (const m of makers.values()) m.start();
  for (const t of takers.values()) t.start();
  const refillTimer = setInterval(() => {
    void pooled([...clients.values()], BOOTSTRAP_CONCURRENCY, async ({ maker, taker, spec }) => {
      await ensureFunded(maker, spec).catch((e: unknown) => log.warn('refill failed', (e as Error).message));
      await ensureFunded(taker, spec).catch((e: unknown) => log.warn('refill failed', (e as Error).message));
    });
  }, REFILL_EVERY_MS);
  log.ok(
    `mirroring ${wanted.length} symbols: ${wanted.map((s) => `${s.market === 'FUTURES' ? 'F:' : ''}${s.symbol}`).join(', ')}`,
  );
  log.info('Ctrl-C to stop (cancels all maker orders).');

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${sig} — shutting down…`);
    clearInterval(refillTimer);
    for (const f of feeds) f.stop();
    for (const t of takers.values()) t.stop();
    await Promise.allSettled([...makers.values()].map((m) => m.clear()));
    log.ok('clean. bye.');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
