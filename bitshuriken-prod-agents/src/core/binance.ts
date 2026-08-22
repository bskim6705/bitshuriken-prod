import ccxt from 'ccxt';
import type { Bar, Market, SymbolSpec } from './types';

/** BTCUSDT → ccxt unified symbol ('BTC/USDT' spot, 'BTC/USDT:USDT' perp). */
export function unifiedSymbol(market: Market, symbol: string): string {
  const quote = symbol.endsWith('USDC') ? 'USDC' : 'USDT';
  const base = symbol.slice(0, -quote.length);
  return market === 'SPOT' ? `${base}/${quote}` : `${base}/${quote}:${quote}`;
}

const decimalsOf = (increment: number): number =>
  increment > 0 && increment < 1 ? Math.max(0, Math.round(-Math.log10(increment))) : 0;

/**
 * SymbolSpec from Binance market metadata (precision/limits), so backtests can run
 * without the local stack and use the same precision the history came from. ccxt
 * Binance reports precision as tick/step increments (TICK_SIZE mode).
 */
export async function fetchSpec(market: Market, symbol: string): Promise<SymbolSpec> {
  const ex = market === 'SPOT' ? new ccxt.binance({ enableRateLimit: true }) : new ccxt.binanceusdm({ enableRateLimit: true });
  await ex.loadMarkets();
  const m = ex.market(unifiedSymbol(market, symbol));
  await ex.close();
  const tickSize = Number(m.precision.price);
  const stepSize = Number(m.precision.amount);
  return {
    symbol,
    market,
    tickSize,
    stepSize,
    pricePrecision: decimalsOf(tickSize),
    qtyPrecision: decimalsOf(stepSize),
    minNotional: Number(m.limits.cost?.min ?? 0),
    baseAsset: m.base,
    quoteAsset: m.quote,
  };
}

const PAGE = 1000; // Binance OHLCV max per request

/**
 * Deep historical klines from Binance public data via ccxt REST, paginated forward.
 * The local exchange only has klines since the dev stack started, so backtests and
 * signal discovery pull real history here. Returns oldest→newest Bars (all final).
 */
export async function fetchHistory(
  market: Market,
  symbol: string,
  timeframe: string,
  sinceMs: number,
  untilMs: number,
): Promise<Bar[]> {
  const ex = market === 'SPOT' ? new ccxt.binance({ enableRateLimit: true }) : new ccxt.binanceusdm({ enableRateLimit: true });
  const u = unifiedSymbol(market, symbol);
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
    if (last <= since) break; // no forward progress
    since = last + tfMs;
    if (rows.length < PAGE) break; // exhausted
  }
  await ex.close();
  return out;
}
