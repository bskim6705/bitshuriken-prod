import type { EquityPoint, Fill } from '../core/types';

export interface Metrics {
  initialCapital: number;
  finalEquity: number;
  totalPnl: number;
  roi: number;
  maxDrawdown: number;
  sharpe: number;
  trades: number;
  winRate: number;
  feesPaid: number;
}

export function maxDrawdown(curve: EquityPoint[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const { equity } of curve) {
    if (equity > peak) peak = equity;
    if (peak > 0) mdd = Math.max(mdd, Math.min(1, (peak - equity) / peak));
  }
  return mdd;
}

/** annualized Sharpe from per-bar equity returns (rf = 0). */
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
  return sd === 0 ? 0 : (m / sd) * Math.sqrt(barsPerYear);
}

/** win rate over closing SELLs by average-cost accounting (entry fees folded into cost). */
export function winRate(fills: Fill[]): number {
  let qty = 0;
  let cost = 0;
  let sells = 0;
  let wins = 0;
  for (const f of fills) {
    if (f.side === 'BUY') {
      qty += f.qty;
      cost += f.price * f.qty + f.fee;
    } else {
      const closeQty = Math.min(f.qty, qty);
      if (closeQty <= 0) continue;
      const avg = cost / qty;
      const pnl = f.price * closeQty - f.fee - avg * closeQty;
      cost -= avg * closeQty;
      qty -= closeQty;
      if (qty <= 1e-12) {
        qty = 0;
        cost = 0;
      }
      sells++;
      if (pnl > 0) wins++;
    }
  }
  return sells ? wins / sells : 0;
}

export function computeMetrics(initialCapital: number, curve: EquityPoint[], fills: Fill[], barsPerYear: number): Metrics {
  const finalEquity = curve.length ? curve[curve.length - 1]!.equity : initialCapital;
  return {
    initialCapital,
    finalEquity,
    totalPnl: finalEquity - initialCapital,
    roi: finalEquity / initialCapital - 1,
    maxDrawdown: maxDrawdown(curve),
    sharpe: sharpe(curve, barsPerYear),
    trades: fills.length,
    winRate: winRate(fills),
    feesPaid: fills.reduce((s, f) => s + f.fee, 0),
  };
}
