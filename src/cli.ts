import { ControlClient } from './control/client';

const client = new ControlClient();
const print = (x: unknown): void => console.log(JSON.stringify(x, null, 2));

/** Parse `k=v` tokens into a params object (numbers coerced). */
function kv(tokens: string[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const t of tokens) {
    const [k, v] = t.split('=');
    if (!k || v === undefined) continue;
    const n = Number(v);
    out[k] = Number.isFinite(n) && v.trim() !== '' ? n : v;
  }
  return out;
}

const USAGE = `bitshuriken-agents cli — talks to agentd (${'`npm run daemon`'})
  status
  strategies
  agents
  start <strategyId> <symbol> [capital=<usdt>] [mirror=true] [<k>=<v> ...]
  stop <agentId>
  tickers
  ensure-ticker <symbol> [market]
  mirror <symbol> [market]            # spawn a bots mirror (live book)
  unmirror <symbol> [market]
  mirrors
  tune <agentId> <k>=<v> ...
  metrics <agentId>
  integrity [agentId]                 # ledger↔balance recon + health (all agents if omitted)
  compare [backtests]
  backtest <strategyId> <symbol> <interval> <days> [<k>=<v> ...]
  scan <symbol> [interval] [lookback]
  klines <symbol> [interval] [limit]`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'status':
      return print(await client.health());
    case 'strategies':
      return print(await client.strategies());
    case 'agents':
      return print(await client.agents());
    case 'start': {
      const [strategyId, symbol, ...rest] = args;
      if (!strategyId || !symbol) throw new Error('start <strategyId> <symbol> [capital=n] [k=v ...]');
      const params = kv(rest);
      const capitalUsdt = params.capital;
      const withMirror = params.mirror === 'true' || params.mirror === 1;
      delete params.capital;
      delete params.mirror;
      return print(
        await client.startAgent({ strategyId, symbol, params, withMirror, ...(capitalUsdt !== undefined ? { capitalUsdt } : {}) }),
      );
    }
    case 'stop':
      if (!args[0]) throw new Error('stop <agentId>');
      return print(await client.stopAgent(args[0]));
    case 'tune':
      if (!args[0]) throw new Error('tune <agentId> <k=v> ...');
      return print(await client.tuneAgent(args[0], kv(args.slice(1))));
    case 'metrics':
      if (!args[0]) throw new Error('metrics <agentId>');
      return print(await client.agentMetrics(args[0]));
    case 'integrity':
      return print(await (args[0] ? client.agentIntegrity(args[0]) : client.integrity()));
    case 'compare':
      return print(await client.compare({ includeBacktests: args[0] === 'backtests' }));
    case 'backtest': {
      const [strategyId, symbol, interval = '1h', daysStr = '30', ...rest] = args;
      if (!strategyId || !symbol) throw new Error('backtest <strategyId> <symbol> <interval> <days> [k=v ...]');
      const to = Date.now();
      const from = to - Number(daysStr) * 86_400_000;
      return print(await client.backtest({ strategyId, symbol, interval, from, to, params: kv(rest) }));
    }
    case 'scan': {
      const [symbol, interval, lookback] = args;
      if (!symbol) throw new Error('scan <symbol> [interval] [lookback]');
      return print(await client.signalScan({ symbol, interval, lookback }));
    }
    case 'klines': {
      const [symbol, interval, limit] = args;
      if (!symbol) throw new Error('klines <symbol> [interval] [limit]');
      return print(await client.klines({ symbol, interval, limit }));
    }
    case 'tickers':
      return print(await client.tickers());
    case 'ensure-ticker':
      if (!args[0]) throw new Error('ensure-ticker <symbol> [market]');
      return print(await client.ensureTicker(args[0], args[1]));
    case 'mirror':
      if (!args[0]) throw new Error('mirror <symbol> [market]');
      return print(await client.startMirror(args[0], args[1]));
    case 'unmirror':
      if (!args[0]) throw new Error('unmirror <symbol> [market]');
      return print(await client.stopMirror(args[0], args[1]));
    case 'mirrors':
      return print(await client.mirrors());
    default:
      console.log(USAGE);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
