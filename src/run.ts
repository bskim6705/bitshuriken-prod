import { config } from './config';
import { LocalExchangeClient } from './exchange';
import { buildFeeds } from './feeds';
import { MakerBot } from './bots/maker';
import { TakerBot } from './bots/taker';
import { makeLogger } from './log';
import type { Feed, Market, SymbolSpec } from './types';

const log = makeLogger('run');

// dev mints per bot. Per-quote so KRW markets (quote=KRW) get funded too.
const QUOTE_DEPOSIT: Record<string, string> = {
  USDT: '100000000', // 100M
  USDC: '100000000',
  KRW: '100000000000', // 100B (≈ 100M USD worth)
};
const DEFAULT_QUOTE_DEPOSIT = '100000000';
const BASE_DEPOSIT = '100000'; // 100k of each base per bot
const FUTURES_MARGIN = '10000000'; // 10M USDT moved to futures wallet per bot

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

async function fund(client: LocalExchangeClient, wanted: SymbolSpec[]): Promise<void> {
  const spot = wanted.filter((s) => s.market === 'SPOT');
  const quotes = new Set(spot.map((s) => s.quoteAsset));
  const bases = new Set(spot.map((s) => s.baseAsset));
  // a base can also be a quote elsewhere (USDT is base of USDTKRW, quote of BTCUSDT) — dedup by symbol.
  for (const q of quotes) await client.deposit(q, QUOTE_DEPOSIT[q] ?? DEFAULT_QUOTE_DEPOSIT);
  for (const b of bases) if (!quotes.has(b)) await client.deposit(b, BASE_DEPOSIT);
  if (wanted.some((s) => s.market === 'FUTURES')) {
    await client.transfer('SPOT', 'FUTURES', 'USDT', FUTURES_MARGIN);
  }
  log.ok(`funded ${client.label}`);
}

async function bootstrap(client: LocalExchangeClient, email: string): Promise<void> {
  await client.ensureAccount(email, config.accounts.password);
  await client.ensureApiKey();
  if (config.adminSecret) {
    await client.ensureRateLimitExempt(config.adminSecret);
    log.ok(`${client.label} rate-limit exempt`);
  } else {
    log.warn(`${client.label}: no ADMIN_API_SECRET — not exempt (ok only while RATE_LIMIT_ENABLED=false)`);
  }
}

async function main(): Promise<void> {
  const maker = new LocalExchangeClient('maker');
  const taker = new LocalExchangeClient('taker');
  await bootstrap(maker, config.accounts.makerEmail);
  await bootstrap(taker, config.accounts.takerEmail);
  log.ok(`accounts ready — maker=${maker.userId} taker=${taker.userId}`);

  const wanted = await resolveWanted(maker);
  if (wanted.length === 0)
    throw new Error('nothing to mirror — exchange listed no tickers (and no *_SYMBOLS override)');

  await fund(maker, wanted);
  await fund(taker, wanted);

  for (const spec of wanted.filter((s) => s.market === 'FUTURES')) {
    await maker.setLeverage(spec.symbol, config.tuning.futuresLeverage).catch(() => {});
    await taker.setLeverage(spec.symbol, config.tuning.futuresLeverage).catch(() => {});
  }

  const makers = new Map<string, MakerBot>();
  const takers = new Map<string, TakerBot>();
  for (const spec of wanted) {
    const key = `${spec.market}:${spec.symbol}`;
    makers.set(
      key,
      new MakerBot(maker, spec, config.tuning.depthLevels, config.tuning.reconcileMs, config.tuning.futuresMaxNotional),
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
  log.ok(
    `mirroring ${wanted.length} symbols: ${wanted.map((s) => `${s.market === 'FUTURES' ? 'F:' : ''}${s.symbol}`).join(', ')}`,
  );
  log.info('Ctrl-C to stop (cancels all maker orders).');

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${sig} — shutting down…`);
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
