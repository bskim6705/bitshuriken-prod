/**
 * Wilder's RSI over the last `len` periods, computed on the full series.
 * Returns 50 when there is not enough data to be meaningful, 100 when there are
 * no losses. Range 0..100.
 */
export function rsi(values: number[], len: number): number {
  if (values.length < len + 1) return 50;
  let gain = 0;
  let loss = 0;
  // seed: first `len` deltas
  for (let i = 1; i <= len; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / len;
  let avgLoss = loss / len;
  // Wilder smoothing across the rest
  for (let i = len + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (len - 1) + Math.max(d, 0)) / len;
    avgLoss = (avgLoss * (len - 1) + Math.max(-d, 0)) / len;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
