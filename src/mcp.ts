#!/usr/bin/env node
// bitshuriken-agents MCP — control plane for the live + backtest strategy fleet.
// Every tool is a thin call to the agentd control API (start it with `npm run daemon`).
// Lets an LLM observe, tune, add, compare, backtest strategies and hunt for signals.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ControlClient } from './control/client';

const client = new ControlClient();
const server = new McpServer({ name: 'bitshuriken-agents', version: '0.1.0' });

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true });
const run = async (fn: () => Promise<unknown>) => {
  try {
    return text(JSON.stringify(await fn(), null, 2));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
};

const paramsArg = z.record(z.union([z.number(), z.string(), z.boolean()]));
const symbolArg = z.string().describe('e.g. BTCUSDT (must exist on the local exchange for live)');
const intervalArg = z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).optional();
const sourceArg = z.enum(['local', 'binance']).optional().describe('local = running exchange, binance = deep history');

server.tool('list_strategies', 'List registered strategies with their tunable parameter schemas.', {}, () =>
  run(() => client.strategies()),
);

server.tool(
  'reload_strategies',
  'Re-import src/strategies/*.ts so a newly authored or edited strategy module is registered. Call after writing a new strategy file.',
  { file: z.string().optional().describe('one file e.g. "my-strategy.ts"; omit to reload all') },
  ({ file }) => run(() => client.reloadStrategies(file)),
);

server.tool('list_agents', 'List running agents (strategy, symbol, subaccount, position, equity).', {}, () =>
  run(() => client.agents()),
);

server.tool(
  'start_agent',
  'Start a live forward-test agent: creates + funds a dedicated subaccount and runs the strategy against the local exchange.',
  {
    strategyId: z.string(),
    symbol: symbolArg,
    market: z.enum(['SPOT']).optional().describe('live is SPOT-only (futures has no engine fills yet)'),
    params: paramsArg.optional(),
    capitalUsdt: z.number().optional(),
    withMirror: z.boolean().optional().describe('also start a bots mirror for the symbol so there is a live book to trade'),
  },
  (args) => run(() => client.startAgent(args)),
);

server.tool('stop_agent', 'Stop an agent (cancels its orders and flattens its position).', { agentId: z.string(), flatten: z.boolean().optional() }, ({ agentId, flatten }) =>
  run(() => client.stopAgent(agentId, flatten ?? true)),
);

server.tool('tune_agent', 'Live-tune a running agent\'s parameters without restarting it.', { agentId: z.string(), params: paramsArg }, ({ agentId, params }) =>
  run(() => client.tuneAgent(agentId, params)),
);

server.tool('get_metrics', 'Performance metrics for one agent (equity curve, PnL, ROI, drawdown, Sharpe, win rate, fees).', { agentId: z.string() }, ({ agentId }) =>
  run(() => client.agentMetrics(agentId)),
);

server.tool(
  'compare',
  'Rank agents (and optionally backtests) by an objective. Always reports the buy-and-hold baseline.',
  {
    agentIds: z.array(z.string()).optional(),
    includeBacktests: z.boolean().optional(),
    objective: z.enum(['sharpe', 'roi', 'totalPnl']).optional(),
  },
  (args) => run(() => client.compare(args)),
);

server.tool(
  'run_backtest',
  'Backtest a strategy over historical Binance klines (deterministic sim fills). Pass days OR explicit from/to (epoch ms).',
  {
    strategyId: z.string(),
    symbol: symbolArg,
    interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']),
    days: z.number().optional().describe('lookback window in days (default 30 if from/to omitted)'),
    from: z.number().optional(),
    to: z.number().optional(),
    params: paramsArg.optional(),
    sim: z.object({ feeBps: z.number().optional(), slippageBps: z.number().optional(), latencyBars: z.number().optional() }).optional(),
  },
  ({ days, from, to, ...rest }) => {
    const end = to ?? Date.now();
    const start = from ?? end - (days ?? 30) * 86_400_000;
    return run(() => client.backtest({ ...rest, from: start, to: end }));
  },
);

server.tool(
  'fetch_klines',
  'Fetch recent OHLCV klines (oldest→newest) from the running exchange or deep Binance history.',
  { symbol: symbolArg, interval: intervalArg, limit: z.number().optional(), endTime: z.number().optional(), source: sourceArg },
  (q) => run(() => client.klines(q)),
);

server.tool(
  'compute_indicators',
  'EMA(12/26), SMA(50), RSI(14), ATR(14) over a kline window — quick read for signal hunting.',
  { symbol: symbolArg, interval: intervalArg, lookback: z.number().optional(), source: sourceArg },
  (q) => run(() => client.indicators(q)),
);

server.tool(
  'signal_scan',
  'Run an indicator battery over a window and summarize trend/momentum/volatility — the starting point for discovering a new strategy.',
  { symbol: symbolArg, interval: intervalArg, lookback: z.number().optional(), source: sourceArg },
  (q) => run(() => client.signalScan(q)),
);

server.tool(
  'list_tickers',
  'List the local exchange tickers with their status (TRADING/PENDING/HALTED/DELISTED).',
  {},
  () => run(() => client.tickers()),
);

server.tool(
  'ensure_ticker',
  'Make a symbol tradable: a seeded ticker is flipped to TRADING at runtime; a brand-new symbol is created but warns it needs a match-engine restart.',
  { symbol: symbolArg, market: z.enum(['SPOT', 'FUTURES']).optional() },
  ({ symbol, market }) => run(() => client.ensureTicker(symbol, market)),
);

server.tool(
  'start_mirror',
  'Spawn a prod bots Binance mirror for a symbol (activates the ticker first), giving live agents a Binance-faithful order book + trades to trade against. Required before a live grid/market-making agent can fill. Needs the bots repo installed at BOTS_DIR (separate service).',
  { symbol: symbolArg, market: z.enum(['SPOT', 'FUTURES']).optional() },
  ({ symbol, market }) => run(() => client.startMirror(symbol, market)),
);

server.tool('stop_mirror', 'Stop the bots mirror for a symbol (cancels its resting book).', { symbol: symbolArg, market: z.enum(['SPOT', 'FUTURES']).optional() }, ({ symbol, market }) =>
  run(() => client.stopMirror(symbol, market)),
);

server.tool('list_mirrors', 'List running bots mirrors (symbol, pid, uptime).', {}, () => run(() => client.mirrors()));

server.tool(
  'scaffold_strategy',
  'Return a strategy-module template. Write it to src/strategies/<name>.ts with your editor, then call reload_strategies, then start_agent / run_backtest.',
  { name: z.string().describe('strategy id, kebab-case, e.g. "mean-reversion"') },
  ({ name }) => text(strategyTemplate(name)),
);

function strategyTemplate(name: string): string {
  const cls = name.replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase());
  return `// src/strategies/${name}.ts — author your edge here, then reload_strategies.
import type { Bar, ExecutionContext, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { ema } from '../indicators/ma';
import { rsi } from '../indicators/rsi';
import { fixedFractionQty } from '../strategy/sizing';

class ${cls} implements Strategy {
  readonly id = '${name}';
  private ctx!: ExecutionContext;
  private p = { lookback: 20, riskFrac: 0.25 };
  private closes: number[] = [];
  get warmupBars(): number { return this.p.lookback + 5; }

  init(ctx: ExecutionContext, params: StrategyParams): void { this.ctx = ctx; this.applyParams(params); }
  applyParams(params: StrategyParams): void {
    for (const k of Object.keys(this.p) as (keyof typeof this.p)[]) {
      const v = params[k]; if (typeof v === 'number') this.p[k] = v;
    }
  }
  warmup(bars: Bar[]): void { for (const b of bars) this.closes.push(b.close); }

  onBar(bar: Bar): void {
    this.closes.push(bar.close);
    if (this.closes.length < this.warmupBars) return;
    const pos = this.ctx.position();
    // TODO: your entry/exit logic. Example: buy on momentum, flatten otherwise.
    const fast = ema(this.closes, 12), slow = ema(this.closes, this.p.lookback);
    if (pos.qty <= 0 && fast > slow) {
      const qty = fixedFractionQty(this.ctx, bar.close, this.p.riskFrac);
      if (qty > 0) void this.ctx.submit({ kind: 'MARKET', side: 'BUY', qty });
    } else if (pos.qty > 0 && fast < slow) {
      void this.ctx.submit({ kind: 'FLATTEN' });
    }
  }
}

const factory: StrategyFactory = {
  id: '${name}',
  paramSchema: {
    lookback: { type: 'number', default: 20, min: 2, max: 400, desc: 'slow lookback' },
    riskFrac: { type: 'number', default: 0.25, min: 0.01, max: 1, desc: 'equity fraction per entry' },
  },
  create: () => new ${cls}(),
};
export default factory;
`;
}

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error('bitshuriken-agents MCP server running on stdio');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
