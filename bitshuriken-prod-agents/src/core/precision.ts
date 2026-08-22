import type { SymbolSpec } from './types';

/** decimals → fixed-point string with exactly `dp` fraction digits (no rounding surprises). */
export function toFixedStr(value: number, dp: number): string {
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return rounded.toFixed(dp);
}

/** snap a price to the symbol's tick grid (round to nearest tick). */
export function roundPrice(spec: SymbolSpec, price: number): string {
  const ticks = Math.round(price / spec.tickSize);
  return toFixedStr(ticks * spec.tickSize, spec.pricePrecision);
}

/** snap a qty DOWN to the symbol's step grid (never over-commit balance). */
export function floorQty(spec: SymbolSpec, qty: number): string {
  const steps = Math.floor(qty / spec.stepSize + 1e-9);
  return toFixedStr(steps * spec.stepSize, spec.qtyPrecision);
}

/** does price*qty clear the symbol's min notional? */
export function meetsMinNotional(spec: SymbolSpec, price: number, qty: number): boolean {
  return price * qty >= spec.minNotional - 1e-9;
}
