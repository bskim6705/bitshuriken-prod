import type { SymbolSpec } from './types';

/** base qty snapped DOWN to the step grid, as the 8-decimal display string the API expects. */
export function floorQty(spec: SymbolSpec, qty: number): string {
  const steps = Math.floor(qty / spec.stepSize + 1e-9);
  return (steps * spec.stepSize).toFixed(spec.qtyPrecision);
}

export const toFixedStr = (x: number, decimals = 8): string => x.toFixed(decimals);
