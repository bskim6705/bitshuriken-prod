import type { Bar } from '../core/types';

/** closing prices of a bar series, oldest→newest. */
export const closes = (bars: Bar[]): number[] => bars.map((b) => b.close);

/** the last `n` values (or fewer if the series is short). */
export const tail = (xs: number[], n: number): number[] => (n >= xs.length ? xs.slice() : xs.slice(xs.length - n));

/** simple mean. NaN on empty input (callers guard length). */
export const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** sample standard deviation (n-1). 0 for <2 points. */
export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** per-step simple returns r_t = x_t/x_{t-1} - 1. */
export function returns(xs: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const prev = xs[i - 1]!;
    if (prev !== 0) out.push(xs[i]! / prev - 1);
  }
  return out;
}
