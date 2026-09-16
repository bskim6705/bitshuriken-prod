import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config';
import { fetchHistory, intervalMs } from '../core/binance';
import type { Logger } from '../core/logger';
import { floorQty, toFixedStr } from '../core/precision';
import type { Bar, EquityPoint, SymbolSpec } from '../core/types';
import { MasterClient, SubaccountClient, exchangeInfo, klines, type AccountTrade, type Creds } from '../exchange/client';
import { liveStatePath } from '../brain/paths';
import type { PolicyParams } from './policy';
import { FlyTrader, WARMUP_BARS } from './trader';

export interface ActionLog {
  t: number;
  action: string;
  yhat: number;
  exposure: number;
  price: number;
  equity: number;
  positionQty: number;
}

/** 재시작을 넘어 살아남는 것: 서브계정 자격증명 + 기록. data/live/<SYMBOL>.json (gitignore, dev 한정 평문). */
export interface LiveState {
  symbol: string;
  interval: string;
  label: string;
  subaccountId: string;
  creds: Creds;
  capitalUsdt: number;
  createdAt: number;
  equityCurve: EquityPoint[];
  actions: ActionLog[];
}

const MAX_CURVE = 5000;
const MAX_ACTIONS = 500;

async function retry<T>(fn: () => Promise<T>, attempts: number, log: Logger): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      log.warn(`attempt ${i}/${attempts} failed, retrying`, (e as Error).message);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

/**
 * 라이브 루프: 로컬 거래소 klines를 폴링해 새 완결 bar마다 잔고 재동기 → 뇌 한 스텝 → 정책 → 시장가 주문.
 * 초파리는 마스터 아래 서브계정 하나로 거래한다 (HMAC 키). 뇌 warmup은 Binance 이력(미러 원천)으로 —
 * 로컬 klines는 스택 기동 이후분만 있어 300 bar가 없을 수 있다.
 */
export class FlyLive {
  status: 'starting' | 'warming' | 'running' | 'stopped' = 'starting';
  lastError: string | null = null;
  consecutiveErrors = 0;
  lastBar: Bar | null = null;
  equity = 0;
  quoteTotal = 0;
  positionQty = 0;
  baseFree = 0;
  quoteFree = 0;
  price = 0;
  fills: AccountTrade[] = [];
  trader!: FlyTrader;
  spec!: SymbolSpec;
  state!: LiveState;
  private client!: SubaccountClient;
  private timer: NodeJS.Timeout | null = null;
  private lastEmitted = 0;
  private seeded = false;
  private busy = false;

  constructor(
    readonly symbol: string,
    private readonly opts: { capital?: number; policy?: Partial<PolicyParams>; modelFile?: string; log: Logger },
  ) {}

  get log(): Logger {
    return this.opts.log;
  }

  async start(): Promise<void> {
    const interval = config.interval;
    this.trader = FlyTrader.load(this.symbol, interval, this.opts.policy, this.opts.modelFile);
    const specs = await retry(() => exchangeInfo(), 3, this.log);
    const spec = specs.find((s) => s.symbol === this.symbol);
    if (!spec) throw new Error(`${this.symbol} is not listed on the local spot exchange (activate the ticker first)`);
    this.spec = spec;
    await this.ensureSubaccount();
    this.client = new SubaccountClient(this.state.creds);
    await this.warmup(interval);
    // Binance warmup(ccxt) 직후 첫 로컬 fetch가 1회 'fetch failed'로 끊기는 일이 재현된다 — 재시도하고, 그래도
    // 안 되면 죽지 않고 매 bar 동기화에 맡긴다
    await retry(() => this.refresh(this.price || this.lastBar?.close || 0), 3, this.log).catch((e: Error) =>
      this.log.warn('initial balance sync failed (retries each bar)', e.message),
    );
    this.status = this.trader.warm ? 'running' : 'warming';
    this.timer = setInterval(() => void this.poll(), config.barPollMs);
    void this.poll();
    this.log.ok(`fly awake on ${this.symbol} ${interval} — sub ${this.state.subaccountId}, equity ${this.equity.toFixed(2)} USDT, ${this.trader.brain.N} neurons`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status = 'stopped';
    this.save();
  }

  /** 상태 파일이 있으면 재사용, 없으면 마스터가 서브계정 생성 → 펀딩 → API 키 발급. */
  private async ensureSubaccount(): Promise<void> {
    const path = liveStatePath(this.symbol);
    if (existsSync(path)) {
      this.state = JSON.parse(readFileSync(path, 'utf8')) as LiveState;
      this.log.info(`resuming subaccount ${this.state.subaccountId} (${this.state.label})`);
      return;
    }
    const master = new MasterClient();
    await master.ensureAccount(config.master.email, config.master.password);
    const capital = this.opts.capital ?? config.capitalUsdt;
    const label = `fly:${this.symbol}:${crypto.randomBytes(3).toString('hex')}`.toLowerCase();
    const sub = await master.createSubaccount(label);
    try {
      await master.deposit('USDT', String(capital));
      await master.transfer(master.userId!, sub.id, 'USDT', String(capital));
      const key = await master.issueApiKey(sub.id, `${label} key`);
      this.state = {
        symbol: this.symbol,
        interval: config.interval,
        label,
        subaccountId: sub.id,
        creds: { apiKey: key.apiKey, secret: key.secret },
        capitalUsdt: capital,
        createdAt: Date.now(),
        equityCurve: [],
        actions: [],
      };
      this.save();
      this.log.ok(`subaccount ${sub.id} (${label}) funded ${capital} USDT`);
    } catch (e) {
      await master.transfer(sub.id, master.userId!, 'USDT', String(capital)).catch(() => {});
      throw e;
    }
  }

  private async warmup(interval: string): Promise<void> {
    let history: Bar[] = [];
    try {
      const to = Date.now();
      history = await fetchHistory(this.symbol, interval, to - (WARMUP_BARS + 2) * intervalMs(interval), to);
      history = history.filter((b) => b.closeTime < to);
      this.log.info(`warmup: ${history.length} bars from Binance`);
    } catch (e) {
      this.log.warn('Binance warmup failed, falling back to local klines', (e as Error).message);
      history = (await klines(this.symbol, interval, WARMUP_BARS + 2)).filter((b) => b.isFinal);
    }
    for (const b of history) this.trader.observe(b);
    if (history.length) {
      this.lastBar = history[history.length - 1]!;
      this.price = this.lastBar.close;
    }
    if (!this.trader.warm) this.log.warn(`only ${history.length} warmup bars — the fly observes until ${WARMUP_BARS} bars have passed before trading`);
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const finals = (await klines(this.symbol, config.interval, 3)).filter((b) => b.isFinal);
      if (!this.seeded) {
        for (const b of finals) this.lastEmitted = Math.max(this.lastEmitted, b.openTime);
        this.seeded = true;
        return;
      }
      for (const b of finals) {
        if (b.openTime > this.lastEmitted) {
          this.lastEmitted = b.openTime;
          await this.onBar(b);
        }
      }
    } catch (e) {
      this.consecutiveErrors++;
      this.lastError = (e as Error).message;
      this.log.warn(`poll failed (${this.consecutiveErrors}x)`, this.lastError);
    } finally {
      this.busy = false;
    }
  }

  /** 잔고가 진실: 매 bar 재동기 (놓친 주문 응답도 자가 치유). */
  private async refresh(mark: number): Promise<void> {
    const bals = await this.client.balances();
    const sum = (asset: string, free = false): number =>
      bals.filter((b) => b.asset === asset).reduce((a, b) => a + Number(b.free) + (free ? 0 : Number(b.locked)), 0);
    this.quoteTotal = sum(this.spec.quoteAsset);
    this.quoteFree = sum(this.spec.quoteAsset, true);
    this.positionQty = sum(this.spec.baseAsset);
    this.baseFree = sum(this.spec.baseAsset, true);
    this.price = mark;
    this.equity = this.quoteTotal + this.positionQty * mark;
  }

  private async onBar(bar: Bar): Promise<void> {
    this.lastBar = bar;
    await this.refresh(bar.close);
    const yhat = this.trader.observe(bar);
    let action = 'observe';
    if (yhat !== null) {
      if (this.trader.warm && this.status === 'warming') this.status = 'running';
      const d = this.trader.decide(yhat, { equity: this.equity, price: bar.close, positionQty: this.positionQty });
      action = await this.execute(d, bar.close);
    }
    this.fills = await this.client.trades(this.symbol, 50).catch(() => this.fills);
    const snap = this.trader.snapshot;
    this.state.equityCurve.push({ t: bar.closeTime, equity: this.equity });
    if (this.state.equityCurve.length > MAX_CURVE) this.state.equityCurve.splice(0, this.state.equityCurve.length - MAX_CURVE);
    this.state.actions.push({ t: bar.closeTime, action, yhat: yhat ?? 0, exposure: snap?.exposure ?? 0, price: bar.close, equity: this.equity, positionQty: this.positionQty });
    if (this.state.actions.length > MAX_ACTIONS) this.state.actions.splice(0, this.state.actions.length - MAX_ACTIONS);
    this.consecutiveErrors = 0;
    this.lastError = null;
    this.save();
    this.log.info(`${new Date(bar.closeTime).toISOString().slice(11, 19)} ${this.symbol} ${bar.close} | ŷ ${yhat === null ? '—' : yhat.toFixed(4)} exposure ${snap ? (snap.exposure * 100).toFixed(0) : '—'}% | ${action} | equity ${this.equity.toFixed(2)} pos ${this.positionQty}`);
  }

  private async execute(d: { kind: string; quoteQty?: number; qty?: number; reason?: string }, price: number): Promise<string> {
    try {
      switch (d.kind) {
        case 'BUY': {
          const quote = Math.min(d.quoteQty!, this.quoteFree);
          if (quote < this.spec.minNotional) return `buy skipped (${quote.toFixed(2)} < minNotional)`;
          const o = await this.client.placeMarket(this.spec, 'BUY', '0', toFixedStr(quote));
          this.trader.markTraded();
          return `BUY ${quote.toFixed(2)} USDT → order ${o.id} ${o.status}`; // 체결은 엔진 비동기 — 다음 bar 잔고/fills에 반영
        }
        case 'SELL':
        case 'FLATTEN': {
          const want = d.kind === 'FLATTEN' ? this.baseFree : Math.min(d.qty!, this.baseFree);
          const qtyStr = floorQty(this.spec, want);
          if (Number(qtyStr) <= 0 || Number(qtyStr) * price < this.spec.minNotional) return `${d.kind.toLowerCase()} skipped (below minNotional)`;
          const o = await this.client.placeMarket(this.spec, 'SELL', qtyStr, '0');
          this.trader.markTraded();
          return `${d.kind} ${qtyStr} → order ${o.id} ${o.status}`;
        }
        default:
          return `hold (${d.reason ?? ''})`;
      }
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log.warn('order failed', this.lastError);
      return `order failed: ${this.lastError}`;
    }
  }

  /** 모든 base free를 시장가로 매도 (수동 청산). */
  async flattenAll(): Promise<string> {
    await this.refresh(this.price);
    return this.execute({ kind: 'FLATTEN' }, this.price);
  }

  private save(): void {
    const path = liveStatePath(this.symbol);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.state, null, 2));
  }

  /** 대시보드 JSON. */
  view(): Record<string, unknown> {
    const m = this.trader.model;
    return {
      symbol: this.symbol,
      interval: config.interval,
      status: this.status,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
      subaccountId: this.state.subaccountId,
      label: this.state.label,
      capitalUsdt: this.state.capitalUsdt,
      equity: this.equity,
      quoteTotal: this.quoteTotal,
      positionQty: this.positionQty,
      price: this.price,
      lastBarTime: this.lastBar?.closeTime ?? null,
      barsSeen: this.trader.history.length,
      warm: this.trader.warm,
      policy: this.trader.policy,
      model: {
        symbol: m.symbol,
        interval: m.interval,
        horizon: m.horizon,
        trainedAt: m.trainedAt,
        valIc: m.train.val.best.ic,
        valHitRate: m.train.val.best.hitRate,
        neurons: m.connectome.N,
        synapses: m.connectome.E,
        region: m.connectome.region,
        brain: m.brain,
      },
      snapshot: this.trader.snapshot,
      history: this.trader.history,
      equityCurve: this.state.equityCurve.slice(-2000),
      actions: this.state.actions.slice(-100).reverse(),
      fills: this.fills.slice(0, 50),
    };
  }
}
