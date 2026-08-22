import { config } from '../config';

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Typed client for the agentd control API. Used by both the MCP server and the CLI. */
export class ControlClient {
  constructor(private readonly base: string = config.control.url) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error(`agentd not reachable at ${this.base} — start it with \`npm run daemon\``);
    }
    const env = (await res.json()) as Envelope;
    if (!env.ok) throw new Error(env.error ?? `${res.status} ${res.statusText}`);
    return env.data;
  }

  private qs(params: Record<string, string | number | undefined>): string {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
    const s = u.toString();
    return s ? `?${s}` : '';
  }

  health(): Promise<unknown> {
    return this.call('GET', '/health');
  }
  strategies(): Promise<unknown> {
    return this.call('GET', '/strategies');
  }
  reloadStrategies(file?: string): Promise<unknown> {
    return this.call('POST', '/strategies/reload', { file });
  }
  agents(): Promise<unknown> {
    return this.call('GET', '/agents');
  }
  startAgent(args: Record<string, unknown>): Promise<unknown> {
    return this.call('POST', '/agents', args);
  }
  agent(id: string): Promise<unknown> {
    return this.call('GET', `/agents/${id}`);
  }
  stopAgent(id: string, flatten = true): Promise<unknown> {
    return this.call('POST', `/agents/${id}/stop`, { flatten });
  }
  tuneAgent(id: string, params: Record<string, unknown>): Promise<unknown> {
    return this.call('POST', `/agents/${id}/params`, { params });
  }
  agentMetrics(id: string): Promise<unknown> {
    return this.call('GET', `/agents/${id}/metrics`);
  }
  integrity(): Promise<unknown> {
    return this.call('GET', '/integrity');
  }
  agentIntegrity(id: string): Promise<unknown> {
    return this.call('GET', `/agents/${id}/integrity`);
  }
  compare(opts: Record<string, unknown>): Promise<unknown> {
    return this.call('POST', '/compare', opts);
  }
  backtest(args: Record<string, unknown>): Promise<unknown> {
    return this.call('POST', '/backtest', args);
  }
  backtests(): Promise<unknown> {
    return this.call('GET', '/backtests');
  }
  tickers(): Promise<unknown> {
    return this.call('GET', '/tickers');
  }
  ensureTicker(symbol: string, market?: string): Promise<unknown> {
    return this.call('POST', '/tickers/ensure', { symbol, market });
  }
  mirrors(): Promise<unknown> {
    return this.call('GET', '/mirrors');
  }
  startMirror(symbol: string, market?: string): Promise<unknown> {
    return this.call('POST', '/mirrors', { symbol, market });
  }
  stopMirror(symbol: string, market?: string): Promise<unknown> {
    return this.call('POST', '/mirrors/stop', { symbol, market });
  }
  klines(q: Record<string, string | number | undefined>): Promise<unknown> {
    return this.call('GET', `/klines${this.qs(q)}`);
  }
  signalScan(q: Record<string, string | number | undefined>): Promise<unknown> {
    return this.call('GET', `/signal-scan${this.qs(q)}`);
  }
  indicators(q: Record<string, string | number | undefined>): Promise<unknown> {
    return this.call('GET', `/indicators${this.qs(q)}`);
  }
}
