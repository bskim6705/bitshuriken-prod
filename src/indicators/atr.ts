import type { Bar } from '../core/types';

/** Average True Range over the last `len` bars (simple average of true ranges). */
export function atr(bars: Bar[], len: number): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)));
  }
  const window = len >= trs.length ? trs : trs.slice(trs.length - len);
  return window.reduce((a, b) => a + b, 0) / window.length;
}
