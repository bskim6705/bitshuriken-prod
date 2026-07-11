import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config';
import type { Market } from '../core/types';
import type { EquityPoint, Metrics } from './types';
import type { StrategyParams } from '../strategy/types';

/** Persisted live-agent record (one JSON file per agent). */
export interface AgentRecord {
  id: string;
  label: string;
  subaccountId: string;
  strategyId: string;
  symbol: string;
  market: Market;
  params: StrategyParams;
  capitalUsdt: number;
  interval: string;
  createdAt: number;
  status: 'running' | 'stopped';
  equityCurve: EquityPoint[];
  metrics?: Metrics;
}

/** Immutable backtest run record. */
export interface BacktestRecord {
  runId: string;
  strategyId: string;
  symbol: string;
  market: Market;
  interval: string;
  from: number;
  to: number;
  params: StrategyParams;
  sim: { feeBps: number; slippageBps: number; latencyBars: number };
  metrics: Metrics;
  createdAt: number;
}

const agentsDir = () => join(config.dataDir, 'agents');
const backtestsDir = () => join(config.dataDir, 'backtests');

function ensure(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

export const store = {
  saveAgent(rec: AgentRecord): void {
    writeJson(join(ensure(agentsDir()), `${rec.id}.json`), rec);
  },
  loadAgent(id: string): AgentRecord | null {
    return readJson<AgentRecord>(join(agentsDir(), `${id}.json`));
  },
  listAgents(): AgentRecord[] {
    const dir = ensure(agentsDir());
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<AgentRecord>(join(dir, f)))
      .filter((r): r is AgentRecord => r !== null);
  },
  saveBacktest(rec: BacktestRecord): void {
    writeJson(join(ensure(backtestsDir()), `${rec.runId}.json`), rec);
  },
  listBacktests(): BacktestRecord[] {
    const dir = ensure(backtestsDir());
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<BacktestRecord>(join(dir, f)))
      .filter((r): r is BacktestRecord => r !== null);
  },
  loadBacktest(runId: string): BacktestRecord | null {
    return readJson<BacktestRecord>(join(backtestsDir(), `${runId}.json`));
  },
};
