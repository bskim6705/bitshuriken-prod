import * as crypto from 'crypto';
import { config } from '../config';
import { MasterClient, SubaccountClient, exchangeInfo, type SubaccountCreds } from '../core/exchange';
import { makeLogger } from '../core/logger';
import type { Market, SymbolSpec } from '../core/types';
import { withDefaults, type StrategyParams } from '../strategy/types';
import { StrategyRegistry } from '../strategy/registry';
import { LiveBroker } from '../broker/live';
import { store, type AgentRecord } from '../metrics/store';
import { buildComparison, type CompareEntry, type CompareObjective, type ComparisonResult } from '../metrics/compare';
import { runBacktest, type BacktestArgs } from '../backtest/engine';
import { BarClock } from './barsource';
import { BotManager } from './bot-manager';
import { AgentRunner } from './agent';

const log = makeLogger('supervisor');

export interface StartAgentArgs {
  strategyId: string;
  symbol: string;
  market?: Market;
  params?: StrategyParams;
  capitalUsdt?: number;
  /** also start a bots mirror for the symbol first, so the agent has a live book. */
  withMirror?: boolean;
}

/** Persisted record + the live credentials (secret at rest in DATA_DIR, gitignored). */
interface StoredAgent extends AgentRecord {
  creds: SubaccountCreds;
}

/** Owns the master account, the strategy registry, and the running agent fleet. */
export class Supervisor {
  private readonly master = new MasterClient();
  readonly registry = new StrategyRegistry();
  readonly bots = new BotManager();
  private readonly agents = new Map<string, AgentRunner>();
  private readonly clocks = new Map<string, BarClock>();
  private readonly specs = new Map<string, SymbolSpec>();
  readonly startedAt = Date.now();

  async init(): Promise<void> {
    await this.master.ensureAccount(config.master.email, config.master.password);
    log.ok(`master ready — ${this.master.userId}`);
    const ids = await this.registry.loadAll();
    log.ok(`strategies: ${ids.join(', ') || '(none)'}`);
    await this.resume();
  }

  // ---- strategies ----
  listStrategies() {
    return this.registry.list().map((f) => ({ id: f.id, paramSchema: f.paramSchema }));
  }
  reloadStrategies(file?: string): Promise<string[]> {
    return file ? this.registry.loadFile(file) : this.registry.loadAll();
  }

  // ---- agents ----
  async startAgent(args: StartAgentArgs): Promise<ReturnType<AgentRunner['status']>> {
    const market = args.market ?? 'SPOT';
    if (market === 'FUTURES') throw new Error('live FUTURES agents are not supported yet (no engine fills); use backtest');
    const factory = this.registry.get(args.strategyId);
    if (!factory) throw new Error(`unknown strategy "${args.strategyId}"`);
    const spec = await this.getSpec(market, args.symbol);
    const params = withDefaults(factory.paramSchema, args.params ?? {});
    const capital = args.capitalUsdt ?? config.agent.capitalUsdt;

    if (args.withMirror) await this.bots.startMirror(args.symbol, market); // provide a live book first

    const shortId = crypto.randomBytes(3).toString('hex');
    const label = `${config.agent.labelPrefix}:${args.strategyId}:${args.symbol}:${shortId}`.toLowerCase();

    // create + fund the subaccount, then issue its trading key. On any failure after
    // creation, refund the subaccount back to the master so no funded orphan leaks.
    const sub = await this.master.createSubaccount(label);
    try {
      await this.master.deposit('USDT', String(capital));
      await this.master.transfer(this.master.userId!, sub.id, 'USDT', String(capital), 'SPOT');
      const key = await this.master.issueApiKey(sub.id, `${label} key`);
      log.ok(`subaccount ${sub.id} funded ${capital} USDT`);

      const record: StoredAgent = {
        id: shortId,
        label,
        subaccountId: sub.id,
        strategyId: args.strategyId,
        symbol: args.symbol,
        market,
        params,
        capitalUsdt: capital,
        interval: config.live.klineInterval,
        createdAt: Date.now(),
        status: 'running',
        equityCurve: [],
        creds: { apiKey: key.apiKey, secret: key.secret },
      };

      const runner = this.buildRunner(record, spec);
      await runner.start(); // persists the record + subscribes only on success
      this.agents.set(record.id, runner);
      return runner.status();
    } catch (e) {
      this.releaseClock(spec.market, spec.symbol); // drop a clock created for an agent that never started
      await this.master.transfer(sub.id, this.master.userId!, 'USDT', String(capital), 'SPOT').catch(() => {});
      throw e;
    }
  }

  async stopAgent(id: string, flatten = true): Promise<void> {
    const runner = this.agents.get(id);
    if (!runner) throw new Error(`unknown agent "${id}"`);
    await runner.stop(flatten);
    this.agents.delete(id);
    this.releaseClock(runner.spec.market, runner.spec.symbol);
  }

  tuneAgent(id: string, params: StrategyParams): ReturnType<AgentRunner['status']> {
    const runner = this.requireAgent(id);
    runner.tune(params);
    return runner.status();
  }

  listAgents() {
    return [...this.agents.values()].map((a) => a.status());
  }
  agentStatus(id: string) {
    return this.requireAgent(id).status();
  }
  agentMetrics(id: string) {
    return this.requireAgent(id).metrics();
  }
  agentIntegrity(id: string) {
    return this.requireAgent(id).integrity();
  }
  /** integrity report for every agent (ledger↔balance recon + health). */
  integrityAll() {
    return Promise.all([...this.agents.values()].map((a) => a.integrity()));
  }

  // ---- backtest ----
  backtest(args: BacktestArgs) {
    const factory = this.registry.get(args.strategyId);
    if (!factory) throw new Error(`unknown strategy "${args.strategyId}"`);
    return runBacktest(factory, args);
  }

  // ---- comparison ----
  async compare(opts: { agentIds?: string[]; includeBacktests?: boolean; objective?: CompareObjective }): Promise<ComparisonResult> {
    const entries: CompareEntry[] = [];
    const wanted = opts.agentIds ?? [...this.agents.keys()];
    for (const id of wanted) {
      const runner = this.agents.get(id);
      if (!runner) continue;
      const s = runner.status();
      entries.push({ id, kind: 'live', strategyId: s.strategyId, symbol: s.symbol, market: s.market, params: s.params, metrics: await runner.metrics() });
    }
    if (opts.includeBacktests) {
      for (const b of store.listBacktests()) {
        entries.push({ id: b.runId, kind: 'backtest', strategyId: b.strategyId, symbol: b.symbol, market: b.market, params: b.params, metrics: b.metrics });
      }
    }
    return buildComparison(entries, opts.objective ?? 'sharpe');
  }

  async shutdown(): Promise<void> {
    for (const c of this.clocks.values()) c.stop();
    this.bots.stopAll();
    log.info('supervisor stopped (agents keep their subaccounts + recorded state)');
  }

  // ---- internals ----
  private requireAgent(id: string): AgentRunner {
    const runner = this.agents.get(id);
    if (!runner) throw new Error(`unknown agent "${id}"`);
    return runner;
  }

  private async getSpec(market: Market, symbol: string): Promise<SymbolSpec> {
    const cacheKey = `${market}:${symbol}`;
    const hit = this.specs.get(cacheKey);
    if (hit) return hit;
    const specs = await exchangeInfo(market);
    for (const s of specs) this.specs.set(`${market}:${s.symbol}`, s);
    const spec = this.specs.get(cacheKey);
    if (!spec) throw new Error(`symbol ${symbol} not found on local ${market}`);
    return spec;
  }

  private clockFor(spec: SymbolSpec, interval: string): BarClock {
    const key = `${spec.market}:${spec.symbol}:${interval}`;
    let clock = this.clocks.get(key);
    if (!clock) {
      clock = new BarClock(spec.market, spec.symbol, interval, config.live.barPollMs);
      this.clocks.set(key, clock);
      clock.start();
    }
    return clock;
  }

  private releaseClock(market: Market, symbol: string): void {
    for (const [key, clock] of this.clocks) {
      if (clock.market === market && clock.symbol === symbol && clock.subscriberCount === 0) {
        clock.stop();
        this.clocks.delete(key);
      }
    }
  }

  /** wire a runner from a record + spec. Does NOT persist or register — the caller does
   *  that only after start() succeeds, so a failed start leaves no phantom running agent. */
  private buildRunner(record: StoredAgent, spec: SymbolSpec): AgentRunner {
    const factory = this.registry.get(record.strategyId);
    if (!factory) throw new Error(`unknown strategy "${record.strategyId}"`);
    const client = new SubaccountClient(record.label, record.creds);
    const broker = new LiveBroker(spec, client, record.capitalUsdt);
    const strategy = factory.create();
    const clock = this.clockFor(spec, record.interval);
    return new AgentRunner(record, spec, strategy, broker, client, clock);
  }

  /** resume agents that were running before a daemon restart (creds persisted in the store). */
  private async resume(): Promise<void> {
    for (const rec of store.listAgents() as StoredAgent[]) {
      if (rec.status !== 'running' || !rec.creds?.apiKey) continue;
      try {
        const spec = await this.getSpec(rec.market, rec.symbol);
        const runner = this.buildRunner(rec, spec);
        await runner.start();
        this.agents.set(rec.id, runner);
      } catch (e) {
        rec.status = 'stopped';
        store.saveAgent(rec);
        this.releaseClock(rec.market, rec.symbol);
        log.warn(`resume ${rec.id} failed (marked stopped)`, (e as Error).message);
      }
    }
  }
}
