import type { Side } from '../core/types';

/** One realized fill in an agent's ledger (sim ledger or BE /account/trades). */
export interface LedgerFill {
  time: number; // epoch ms
  side: Side;
  price: number;
  qty: number; // base
  fee: number; // quote
}

/** A point on the mark-to-market equity curve. */
export interface EquityPoint {
  t: number; // epoch ms
  equity: number; // quote (USDT)
}

/** Comparable performance summary — same shape for live and backtest. */
export interface Metrics {
  initialCapital: number;
  finalEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  roi: number; // fraction, e.g. 0.12 = +12%
  maxDrawdown: number; // fraction of peak, e.g. 0.2 = -20%
  sharpe: number; // annualized, per-bar returns
  tradeCount: number; // fills
  winRate: number; // fraction of closed round-trips that were positive
  feesPaid: number;
  equityCurve: EquityPoint[];
}

export interface ComputeMetricsInput {
  initialCapital: number;
  fills: LedgerFill[];
  equityCurve: EquityPoint[];
  /** bars per year for Sharpe annualization (e.g. 525600 for 1m, 8760 for 1h). */
  barsPerYear: number;
}
