import * as crypto from 'crypto';
import { config } from '../config';
import { fetchHistory, fetchSpec } from '../core/binance';
import { makeLogger } from '../core/logger';
import type { Market } from '../core/types';
import { withDefaults, type StrategyFactory, type StrategyParams } from '../strategy/types';
import { SimBroker, type SimConfig } from '../broker/sim';
import { barsPerYear, computeMetrics } from '../metrics/compute';
import { store, type BacktestRecord } from '../metrics/store';

const log = makeLogger('backtest');

export interface BacktestArgs {
  strategyId: string;
  symbol: string;
  market?: Market;
  interval: string;
  from: number; // epoch ms
  to: number; // epoch ms
  params?: StrategyParams;
  sim?: Partial<SimConfig>;
  capitalUsdt?: number;
}

/**
 * Replay Binance history through a strategy under SimBroker and store the result.
 * Deterministic given (bars, params, sim) — runs without the local stack.
 */
export async function runBacktest(factory: StrategyFactory, args: BacktestArgs): Promise<BacktestRecord> {
  const market = args.market ?? 'SPOT';
  const spec = await fetchSpec(market, args.symbol);
  const bars = await fetchHistory(market, args.symbol, args.interval, args.from, args.to);
  const params = withDefaults(factory.paramSchema, args.params ?? {});
  const sim: SimConfig = {
    feeBps: args.sim?.feeBps ?? config.sim.feeBps,
    slippageBps: args.sim?.slippageBps ?? config.sim.slippageBps,
    latencyBars: args.sim?.latencyBars ?? config.sim.latencyBars,
  };
  const capital = args.capitalUsdt ?? config.agent.capitalUsdt;

  const strategy = factory.create();
  const warmup = strategy.warmupBars;
  if (bars.length < warmup + 2) {
    throw new Error(`not enough bars (${bars.length}) for warmup ${warmup}; widen the date range`);
  }

  const broker = new SimBroker(spec, capital, sim);
  strategy.init(broker, params);
  if (strategy.onFill) broker.onFill((f) => strategy.onFill!(f));
  strategy.warmup(bars.slice(0, warmup));
  for (let i = warmup; i < bars.length; i++) {
    const bar = bars[i]!;
    broker.beginBar(i, bar);
    await strategy.onBar(bar);
    broker.endBar(bar);
  }

  const metrics = computeMetrics({
    initialCapital: capital,
    fills: broker.ledger(),
    equityCurve: broker.equityCurve(),
    barsPerYear: barsPerYear(args.interval),
  });

  const record: BacktestRecord = {
    runId: `${factory.id}-${args.symbol}-${args.interval}-${crypto.randomBytes(3).toString('hex')}`.toLowerCase(),
    strategyId: factory.id,
    symbol: args.symbol,
    market,
    interval: args.interval,
    from: args.from,
    to: args.to,
    params,
    sim,
    metrics,
    createdAt: Date.now(),
  };
  store.saveBacktest(record);
  log.ok(`${record.runId}: ROI ${(metrics.roi * 100).toFixed(2)}% over ${bars.length} bars, ${metrics.tradeCount} fills`);
  return record;
}
