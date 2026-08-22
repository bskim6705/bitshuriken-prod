import type { Market } from '../core/types';
import type { StrategyParams } from '../strategy/types';
import type { Metrics } from './types';

export type CompareObjective = 'sharpe' | 'roi' | 'totalPnl';

export interface CompareEntry {
  id: string;
  kind: 'live' | 'backtest';
  strategyId: string;
  symbol: string;
  market: Market;
  params: StrategyParams;
  metrics: Metrics;
}

export interface ComparisonRow {
  id: string;
  kind: 'live' | 'backtest';
  strategyId: string;
  symbol: string;
  params: StrategyParams;
  roi: number;
  totalPnl: number;
  maxDrawdown: number;
  sharpe: number;
  tradeCount: number;
  winRate: number;
  feesPaid: number;
  rank: number;
}

export interface ComparisonResult {
  objective: CompareObjective;
  rows: ComparisonRow[];
  baselineId: string | null;
}

/** Rank entries by an objective (desc), tie-broken by ROI. baseline = first buy-and-hold. */
export function buildComparison(entries: CompareEntry[], objective: CompareObjective = 'sharpe'): ComparisonResult {
  const score = (m: Metrics): number => (objective === 'roi' ? m.roi : objective === 'totalPnl' ? m.totalPnl : m.sharpe);
  const sorted = [...entries].sort((a, b) => score(b.metrics) - score(a.metrics) || b.metrics.roi - a.metrics.roi);
  const rows: ComparisonRow[] = sorted.map((e, i) => ({
    id: e.id,
    kind: e.kind,
    strategyId: e.strategyId,
    symbol: e.symbol,
    params: e.params,
    roi: e.metrics.roi,
    totalPnl: e.metrics.totalPnl,
    maxDrawdown: e.metrics.maxDrawdown,
    sharpe: e.metrics.sharpe,
    tradeCount: e.metrics.tradeCount,
    winRate: e.metrics.winRate,
    feesPaid: e.metrics.feesPaid,
    rank: i + 1,
  }));
  const baseline = sorted.find((e) => e.strategyId === 'buy-and-hold');
  return { objective, rows, baselineId: baseline?.id ?? null };
}
