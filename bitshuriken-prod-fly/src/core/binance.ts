import ccxt from 'ccxt';
import type { Bar, SymbolSpec } from './types';

/** BTCUSDT → 'BTC/USDT' (spot). */
export function unifiedSymbol(symbol: string): string {
  const quote = symbol.endsWith('USDC') ? 'USDC' : 'USDT';
  return `${symbol.slice(0, -quote.length)}/${quote}`;
}

const decimalsOf = (increment: number): number => (increment > 0 && increment < 1 ? Math.max(0, Math.round(-Math.log10(increment))) : 0);

/** SymbolSpec from Binance market metadata so backtests run without the local stack. */
export async function fetchSpec(symbol: string): Promise<SymbolSpec> {
  const ex = new ccxt.binance({ enableRateLimit: true });
  await ex.loadMarkets();
  const m = ex.market(unifiedSymbol(symbol));
  await ex.close();
  const tickSize = Number(m.precision.price);
  const stepSize = Number(m.precision.amount);
  return {
    symbol,
    tickSize,
    stepSize,
    pricePrecision: decimalsOf(tickSize),
    qtyPrecision: decimalsOf(stepSize),
    minNotional: Number(m.limits.cost?.min ?? 0),
    baseAsset: m.base,
    quoteAsset: m.quote,
  };
}

const PAGE = 1000;

/** Deep historical klines from Binance public data (paginated forward). Oldest→newest, all final. */
export async function fetchHistory(symbol: string, timeframe: string, sinceMs: number, untilMs: number): Promise<Bar[]> {
  const ex = new ccxt.binance({ enableRateLimit: true });
  const u = unifiedSymbol(symbol);
  const tfMs = ex.parseTimeframe(timeframe) * 1000;
  const out: Bar[] = [];
  let since = sinceMs;
  while (since < untilMs) {
    const rows = (await ex.fetchOHLCV(u, timeframe, since, PAGE)) as [number, number, number, number, number, number][];
    if (rows.length === 0) break;
    for (const [ts, open, high, low, close, volume] of rows) {
      if (ts > untilMs) break;
      out.push({ openTime: ts, open, high, low, close, volume, closeTime: ts + tfMs - 1, isFinal: true });
    }
    const last = rows[rows.length - 1]![0];
    if (last <= since) break;
    since = last + tfMs;
    if (rows.length < PAGE) break;
  }
  await ex.close();
  return out;
}

export function intervalMs(interval: string): number {
  const m = /^(\d+)([mhd])$/.exec(interval);
  if (!m) throw new Error(`unsupported interval "${interval}"`);
  const n = Number(m[1]);
  return n * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
}
