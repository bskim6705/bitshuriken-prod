import { tail, mean } from './series';

/** Simple moving average of the last `len` values. Returns the mean of all if shorter. */
export function sma(values: number[], len: number): number {
  if (values.length === 0) return NaN;
  return mean(tail(values, len));
}

/**
 * Exponential moving average over the whole series (seeded with the first value),
 * returning the latest EMA. Standard α = 2/(len+1).
 */
export function ema(values: number[], len: number): number {
  if (values.length === 0) return NaN;
  const a = 2 / (len + 1);
  let e = values[0]!;
  for (let i = 1; i < values.length; i++) e = values[i]! * a + e * (1 - a);
  return e;
}
