import type { Bar } from '../core/types';
import { closes, returns, stddev } from './series';
import { ema, sma } from './ma';
import { rsi } from './rsi';
import { atr } from './atr';

export interface SignalScan {
  symbol: string;
  interval: string;
  bars: number;
  lastPrice: number;
  emaFast: number; // 12
  emaSlow: number; // 26
  maCross: 'bullish' | 'bearish'; // emaFast vs emaSlow
  sma50: number;
  trend: 'up' | 'down'; // price vs sma50
  rsi14: number;
  rsiState: 'overbought' | 'oversold' | 'neutral';
  atr14: number;
  atrPct: number; // atr / lastPrice
  volatilityPct: number; // stddev of per-bar returns
  returnPct: number; // total return across the window
  notes: string[];
}

/**
 * Run a battery of indicators over a kline window and summarize them for an LLM to
 * read when hunting for an edge. Pure; no I/O. Caller supplies enough bars (>= ~60).
 */
export function signalScan(symbol: string, interval: string, bars: Bar[]): SignalScan {
  const c = closes(bars);
  const last = c[c.length - 1] ?? 0;
  const emaFast = ema(c, 12);
  const emaSlow = ema(c, 26);
  const sma50 = sma(c, 50);
  const r14 = rsi(c, 14);
  const a14 = atr(bars, 14);
  const vol = stddev(returns(c));
  const first = c[0] ?? last;
  const ret = first !== 0 ? last / first - 1 : 0;

  const rsiState: SignalScan['rsiState'] = r14 >= 70 ? 'overbought' : r14 <= 30 ? 'oversold' : 'neutral';
  const notes: string[] = [];
  if (emaFast > emaSlow) notes.push('fast EMA above slow EMA — momentum up');
  else notes.push('fast EMA below slow EMA — momentum down');
  if (rsiState !== 'neutral') notes.push(`RSI ${rsiState} (${r14.toFixed(1)})`);
  if (vol > 0.02) notes.push('elevated per-bar volatility — favors mean-reversion / wider stops');

  return {
    symbol,
    interval,
    bars: bars.length,
    lastPrice: last,
    emaFast,
    emaSlow,
    maCross: emaFast >= emaSlow ? 'bullish' : 'bearish',
    sma50,
    trend: last >= sma50 ? 'up' : 'down',
    rsi14: r14,
    rsiState,
    atr14: a14,
    atrPct: last !== 0 ? a14 / last : 0,
    volatilityPct: vol,
    returnPct: ret,
    notes,
  };
}
