import type { Market } from '../core/types';
import type { StrategyParams } from '../strategy/types';

/** Live, serializable snapshot of one agent — what the control API returns in lists. */
export interface AgentStatus {
  id: string;
  label: string;
  subaccountId: string;
  strategyId: string;
  symbol: string;
  market: Market;
  interval: string;
  params: StrategyParams;
  capitalUsdt: number;
  status: 'running' | 'stopped';
  createdAt: number;
  positionQty: number;
  equityUsdt: number;
  lastBarTime: number | null;
  consecutiveErrors: number;
  lastError: string | null;
}
