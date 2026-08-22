import { floorQty } from '../core/precision';
import type { ExecutionContext } from './types';

/**
 * Base-asset qty for spending `frac` of current equity at `price`, snapped DOWN to the
 * step grid. Returns 0 when the result is below one step or fails min-notional.
 */
export function fixedFractionQty(ctx: ExecutionContext, price: number, frac: number): number {
  if (price <= 0 || frac <= 0) return 0;
  const notional = ctx.equityUsdt() * Math.min(frac, 1);
  const qty = Number(floorQty(ctx.spec, notional / price));
  if (qty <= 0 || price * qty < ctx.spec.minNotional) return 0;
  return qty;
}
