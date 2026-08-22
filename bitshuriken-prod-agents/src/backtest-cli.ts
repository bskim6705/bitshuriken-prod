import { makeLogger } from './core/logger';
import { StrategyRegistry } from './strategy/registry';
import { runBacktest } from './backtest/engine';
import type { StrategyParams } from './strategy/types';

const log = makeLogger('backtest-cli');

/** Parse trailing `k=v` args into strategy params (numbers coerced). */
function parseParams(args: string[]): StrategyParams {
  const out: StrategyParams = {};
  for (const a of args) {
    const [k, v] = a.split('=');
    if (!k || v === undefined) continue;
    const n = Number(v);
    out[k] = Number.isFinite(n) && v.trim() !== '' ? n : v;
  }
  return out;
}

async function main(): Promise<void> {
  const [strategyId, symbol, interval = '1h', daysStr = '30', ...rest] = process.argv.slice(2);
  if (!strategyId || !symbol) {
    log.err('usage: npm run backtest <strategyId> <symbol> <interval=1h> <days=30> [k=v ...]');
    process.exit(1);
  }
  const days = Number(daysStr);
  const to = Date.now();
  const from = to - days * 86_400_000;

  const reg = new StrategyRegistry();
  await reg.loadAll();
  const factory = reg.get(strategyId);
  if (!factory) {
    log.err(`unknown strategy "${strategyId}". available: ${reg.list().map((f) => f.id).join(', ')}`);
    process.exit(1);
  }

  const rec = await runBacktest(factory, { strategyId, symbol, interval, from, to, params: parseParams(rest) });
  const m = rec.metrics;
  log.ok(`backtest ${rec.runId}`);
  console.error(
    JSON.stringify(
      {
        runId: rec.runId,
        roiPct: +(m.roi * 100).toFixed(2),
        totalPnl: +m.totalPnl.toFixed(2),
        maxDrawdownPct: +(m.maxDrawdown * 100).toFixed(2),
        sharpe: +m.sharpe.toFixed(2),
        trades: m.tradeCount,
        winRatePct: +(m.winRate * 100).toFixed(1),
        feesPaid: +m.feesPaid.toFixed(2),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
