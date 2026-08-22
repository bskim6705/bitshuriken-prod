import type { Feed, FeedSymbol, Market, MirrorSource, SymbolSpec } from '../types';
import { sourceOf } from '../types';
import { BinanceFeed } from './binance';
import { UpbitFeed } from './upbit';

const feedSymbol = (s: SymbolSpec): FeedSymbol => ({
  symbol: s.symbol,
  baseAsset: s.baseAsset,
  quoteAsset: s.quoteAsset,
});

function makeFeed(source: MirrorSource, market: Market, syms: FeedSymbol[], levels: number): Feed {
  return source === 'UPBIT'
    ? new UpbitFeed(market, syms, levels)
    : new BinanceFeed(market, syms, levels);
}

/**
 * Build one feed per (source, market) group over the wanted specs. USDT/USDC tickers route to
 * Binance, KRW tickers to Upbit; Upbit is spot-only so a KRW futures spec (shouldn't exist) is
 * dropped by the grouping.
 */
export function buildFeeds(wanted: SymbolSpec[], levels: number): { feed: Feed; specs: SymbolSpec[] }[] {
  const groups = new Map<string, SymbolSpec[]>();
  for (const s of wanted) {
    const source = sourceOf(s);
    if (source === 'UPBIT' && s.market !== 'SPOT') continue; // Upbit has no perps
    const key = `${source}:${s.market}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }
  const out: { feed: Feed; specs: SymbolSpec[] }[] = [];
  for (const [key, specs] of groups) {
    const [source, market] = key.split(':') as [MirrorSource, Market];
    out.push({ feed: makeFeed(source, market, specs.map(feedSymbol), levels), specs });
  }
  return out;
}

/** A one-shot REST book reader per source, for the parity checker (no streaming). */
export function restFeed(source: MirrorSource, market: Market, syms: FeedSymbol[]): Feed {
  return makeFeed(source, market, syms, 5);
}
