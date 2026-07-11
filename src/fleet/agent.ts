import type { SubaccountClient } from '../core/exchange';
import { klines } from '../core/exchange';
import { makeLogger, type Logger } from '../core/logger';
import type { Bar, SymbolSpec } from '../core/types';
import type { Strategy, StrategyParams } from '../strategy/types';
import type { LiveBroker } from '../broker/live';
import { computeLiveMetrics } from '../metrics/live';
import type { Metrics } from '../metrics/types';
import { allTrades, buildIntegrity, intervalToMs, reconcile, type IntegrityReport } from '../metrics/integrity';
import { store, type AgentRecord } from '../metrics/store';
import type { BarClock } from './barsource';
import type { AgentStatus } from './state';

const MAX_CURVE = 5000;

/** Binds one Strategy to one LiveBroker + a shared BarClock; the live forward-test loop. */
export class AgentRunner {
  private unsub: (() => void) | null = null;
  private lastBarTime: number | null = null;
  private processing = false;
  private inFlight: Promise<void> | null = null;
  private consecutiveErrors = 0;
  private lastError: string | null = null;
  private readonly log: Logger;

  constructor(
    readonly record: AgentRecord,
    readonly spec: SymbolSpec,
    private readonly strategy: Strategy,
    private readonly broker: LiveBroker,
    private readonly client: SubaccountClient,
    private readonly clock: BarClock,
  ) {
    this.log = makeLogger(`agent:${record.id}`);
  }

  async start(): Promise<void> {
    this.strategy.init(this.broker, this.record.params);
    const history = await klines(this.spec.market, this.spec.symbol, this.record.interval, this.strategy.warmupBars + 2);
    this.strategy.warmup(history.filter((b) => b.isFinal));
    if (this.strategy.onFill) this.broker.onFill((f) => this.strategy.onFill!(f));
    this.unsub = this.clock.onBar((bar) => {
      this.inFlight = this.onBar(bar);
    });
    this.record.status = 'running';
    store.saveAgent(this.record);
    this.log.ok(`started ${this.record.strategyId} on ${this.spec.symbol} (sub ${this.record.subaccountId})`);
  }

  private async onBar(bar: Bar): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.broker.refresh(bar.close);
      await this.strategy.onBar(bar);
      this.lastBarTime = bar.closeTime;
      this.record.equityCurve.push({ t: bar.closeTime, equity: this.broker.equityUsdt() });
      if (this.record.equityCurve.length > MAX_CURVE) this.record.equityCurve.splice(0, this.record.equityCurve.length - MAX_CURVE);
      this.consecutiveErrors = 0;
      this.lastError = null;
      store.saveAgent(this.record);
    } catch (e) {
      this.consecutiveErrors += 1;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log.warn(`bar handling failed (${this.consecutiveErrors}x)`, this.lastError);
    } finally {
      this.processing = false;
    }
  }

  tune(params: StrategyParams): void {
    Object.assign(this.record.params, params);
    this.strategy.applyParams(this.record.params);
    store.saveAgent(this.record);
    this.log.ok(`tuned ${JSON.stringify(params)}`);
  }

  async stop(flatten: boolean): Promise<void> {
    this.unsub?.();
    this.unsub = null;
    await this.inFlight?.catch(() => {}); // let an in-flight bar finish before flattening
    if (flatten) {
      await this.client.cancelAll(this.spec.market, this.spec.symbol).catch(() => {});
      await this.broker.submit({ kind: 'FLATTEN' });
    }
    this.record.status = 'stopped';
    store.saveAgent(this.record);
    this.log.ok('stopped');
  }

  async metrics(): Promise<Metrics> {
    const m = await computeLiveMetrics(this.client, {
      market: this.spec.market,
      symbol: this.spec.symbol,
      quoteAsset: this.spec.quoteAsset,
      initialCapital: this.record.capitalUsdt,
      interval: this.record.interval,
      equityCurve: this.record.equityCurve,
    });
    this.record.metrics = m;
    store.saveAgent(this.record);
    return m;
  }

  /** ledger↔balance reconciliation + operational health for this agent's subaccount. */
  async integrity(): Promise<IntegrityReport> {
    const { trades, truncated } = await allTrades(this.client, this.spec.market, this.spec.symbol);
    const balances = await this.client.balances(this.spec.market);
    const recon = reconcile(this.record.capitalUsdt, this.spec.quoteAsset, this.spec.baseAsset, trades, balances, truncated);
    return buildIntegrity(
      { agentId: this.record.id, label: this.record.label, strategyId: this.record.strategyId, symbol: this.spec.symbol, agentStatus: this.record.status },
      {
        running: this.record.status === 'running',
        consecutiveErrors: this.consecutiveErrors,
        lastError: this.lastError,
        lastBarTime: this.lastBarTime,
        intervalMs: intervalToMs(this.record.interval),
        now: Date.now(),
        equityUsdt: this.broker.equityUsdt(),
        positionQty: this.broker.position().qty,
      },
      recon,
      { quote: Math.max(1e-4, this.record.capitalUsdt * 1e-6), base: Math.max(this.spec.stepSize, 1e-8) },
    );
  }

  status(): AgentStatus {
    return {
      id: this.record.id,
      label: this.record.label,
      subaccountId: this.record.subaccountId,
      strategyId: this.record.strategyId,
      symbol: this.spec.symbol,
      market: this.spec.market,
      interval: this.record.interval,
      params: this.record.params,
      capitalUsdt: this.record.capitalUsdt,
      status: this.record.status,
      createdAt: this.record.createdAt,
      positionQty: this.broker.position().qty,
      equityUsdt: this.broker.equityUsdt(),
      lastBarTime: this.lastBarTime,
      consecutiveErrors: this.consecutiveErrors,
      lastError: this.lastError,
    };
  }
}
