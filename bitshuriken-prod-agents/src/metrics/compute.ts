import type { ComputeMetricsInput, EquityPoint, Metrics } from './types';

/** Peak-to-trough max drawdown as a fraction of the running peak (0..1). */
export function maxDrawdown(curve: EquityPoint[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const { equity } of curve) {
    if (equity > peak) peak = equity;
    if (peak > 0) mdd = Math.max(mdd, Math.min(1, (peak - equity) / peak));
  }
  return mdd;
}

/** Annualized Sharpe from per-bar equity returns (rf=0). 0 when undefined. */
export function sharpe(curve: EquityPoint[], barsPerYear: number): number {
  if (curve.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1]!.equity;
    if (prev > 0) rets.push(curve[i]!.equity / prev - 1);
  }
  if (rets.length < 2) return 0;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(barsPerYear);
}

/**
 * Realized PnL + win-rate via average-cost accounting (long-only oriented; spot).
 * Entry fees are folded into the cost basis, so an open long's entry fee stays in
 * unrealized until it's closed. A closing SELL is a "win" when its net PnL (after both
 * entry and exit fees) is positive. SELLs that close nothing (no position) are ignored.
 */
function realizedAndWins(fills: ComputeMetricsInput['fills']): { realized: number; sells: number; wins: number } {
  let qty = 0;
  let costBasis = 0; // total cost of the open position, incl. entry fees
  let realized = 0;
  let sells = 0;
  let wins = 0;
  for (const f of fills) {
    if (f.side === 'BUY') {
      qty += f.qty;
      costBasis += f.price * f.qty + f.fee;
    } else {
      const closeQty = Math.min(f.qty, qty);
      if (closeQty <= 0) continue; // sell with no position (e.g. window starts mid-stream)
      const avgCost = costBasis / qty;
      const pnl = f.price * closeQty - f.fee - avgCost * closeQty;
      realized += pnl;
      costBasis -= avgCost * closeQty;
      qty -= closeQty;
      if (qty <= 1e-12) {
        qty = 0;
        costBasis = 0;
      }
      sells += 1;
      if (pnl > 0) wins += 1;
    }
  }
  return { realized, sells, wins };
}

export function computeMetrics(input: ComputeMetricsInput): Metrics {
  const { initialCapital, fills, equityCurve, barsPerYear } = input;
  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1]!.equity : initialCapital;
  const totalPnl = finalEquity - initialCapital;
  const { realized, sells, wins } = realizedAndWins(fills);
  const feesPaid = fills.reduce((a, f) => a + f.fee, 0);

  return {
    initialCapital,
    finalEquity,
    realizedPnl: realized,
    unrealizedPnl: totalPnl - realized,
    totalPnl,
    roi: initialCapital > 0 ? totalPnl / initialCapital : 0,
    maxDrawdown: maxDrawdown(equityCurve),
    sharpe: sharpe(equityCurve, barsPerYear),
    tradeCount: fills.length,
    winRate: sells > 0 ? wins / sells : 0,
    feesPaid,
    equityCurve,
  };
}

/** bars-per-year for Sharpe annualization, by interval. */
export function barsPerYear(interval: string): number {
  const minutes: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
  const m = minutes[interval] ?? 60;
  return (365 * 24 * 60) / m;
}
