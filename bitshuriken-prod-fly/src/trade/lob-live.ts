import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config';
import type { Logger } from '../core/logger';
import { floorQty, toFixedStr } from '../core/precision';
import type { EquityPoint, SymbolSpec } from '../core/types';
import { FlyBrain, type PopulationActivity } from '../brain/brain';
import { Connectome } from '../brain/connectome';
import { loadModel, type FlyModel } from '../brain/model';
import { connectomePath, liveStatePath, modelPath } from '../brain/paths';
import { pool, predict, type Readout } from '../brain/readout';
import { MasterClient, SubaccountClient, exchangeInfo, type AccountTrade } from '../exchange/client';
import { LOB_FEATURES, LobFeatures } from '../lob/features';
import { DEPTH_LEVELS, LobSampler } from '../lob/recorder';
import { type LobSample, mid as midOf } from '../lob/sample';
import { LobStream } from '../lob/stream';
import { SETTLE } from '../evo/evaluate';
import type { ActionLog, LiveState } from './live';

const MAX_CURVE = 5000;
const MAX_ACTIONS = 500;
const HISTORY = 600;
const BALANCE_REFRESH_MS = 10_000;

/**
 * 실시간 라이브: 로컬 `/ws/market` depth·trade → 1초 샘플 → 오더북 피처 → 뇌 → 하강뉴런 판독 → 임계 정책 → 시장가.
 * 모델은 진화(`evolve`)가 남긴 lob 모델. warmup은 스트림 자체로(피처 120s + 뇌 자리잡기 180s = 5분 관찰).
 * 잔고는 주문 직후와 10초마다 재동기(잔고가 진실); 그 사이 equity는 mid로 마크.
 */
export class LobLive {
  status: 'starting' | 'warming' | 'running' | 'stopped' = 'starting';
  lastError: string | null = null;
  consecutiveErrors = 0;
  equity = 0;
  quoteTotal = 0;
  quoteFree = 0;
  positionQty = 0;
  baseFree = 0;
  price = 0;
  fills: AccountTrade[] = [];
  spec!: SymbolSpec;
  state!: LiveState;
  model: FlyModel;
  brain: FlyBrain;
  readonly fx = new LobFeatures();
  readonly readout: Readout;
  readonly history: { t: number; yhat: number; exposure: number }[] = [];
  snapshot: { t: number; price: number; yhat: number; yScale: number; exposure: number; populations: PopulationActivity[]; descending: number[]; features: number[] } | null = null;
  lastSample: LobSample | null = null;
  private client!: SubaccountClient;
  private readonly stream: LobStream;
  private readonly sampler: LobSampler;
  private samples = 0;
  private settled = -1;
  private entryT = 0;
  /**
   * 포지션 상태 기계 — 잔고가 아니라 주문 접수로 바꾼다 (체결·정산은 비동기라 잔고가 몇 초 늦고, 조회가 실패할 수도 있다).
   * 잔고와 30초 이상 어긋나면 잔고를 따른다 (주문 거절·유실 복구).
   */
  private side: 'flat' | 'long' = 'flat';
  private sideChangedAt = 0;
  private lastBalanceAt = 0;
  private busy = false;
  private pending: Promise<void> | null = null;

  private readonly statePath: string;
  private lastStatusAt = 0;

  constructor(
    readonly symbol: string,
    private readonly opts: {
      capital?: number;
      modelFile?: string;
      /** 파일 대신 모델 객체 (리그 워커). */
      model?: FlyModel;
      /** 서브계정 상태 파일 (기본 data/live/<SYMBOL>.json). 리그는 슬롯별. */
      statePath?: string;
      /** 서브계정 라벨 접두 (기본 fly:<symbol>). */
      label?: string;
      /** 있으면 매 샘플 view()를 이 파일에 쓴다 (리그 매니저·대시보드가 읽음). */
      statusPath?: string;
      log: Logger;
    },
  ) {
    this.statePath = opts.statePath ?? liveStatePath(symbol);
    const path = opts.modelFile ?? modelPath(symbol, '1s');
    if (!opts.model && !existsSync(path)) throw new Error(`no lob model at ${path} — run: npm run fly record ${symbol} (≥ 1h) then npm run fly evolve ${symbol}`);
    this.model = opts.model ?? loadModel(path);
    if (this.model.inputKind !== 'lob' || !this.model.lobPolicy) throw new Error(`${path} is not a lob model`);
    const conn = Connectome.load(connectomePath(this.model.connectome.region));
    if (conn.N !== this.model.connectome.N || conn.E !== this.model.connectome.E) throw new Error('connectome differs from the model — re-evolve');
    this.brain = new FlyBrain(conn, this.model.brain, LOB_FEATURES);
    this.readout = { dim: this.model.readout.dim, w: Float32Array.from(this.model.readout.w), b: this.model.readout.b };
    this.stream = new LobStream(symbol, DEPTH_LEVELS, opts.log);
    this.sampler = new LobSampler(this.stream, (s) => {
      this.pending = this.onSample(s);
    });
  }

  get log(): Logger {
    return this.opts.log;
  }
  get warm(): boolean {
    return this.settled >= 0 && this.samples - this.settled >= SETTLE;
  }

  async start(): Promise<void> {
    const specs = await exchangeInfo();
    const spec = specs.find((s) => s.symbol === this.symbol);
    if (!spec) throw new Error(`${this.symbol} is not listed on the local spot exchange`);
    this.spec = spec;
    await this.ensureSubaccount();
    this.client = new SubaccountClient(this.state.creds);
    await this.refresh().catch((e: Error) => this.log.warn('initial balance sync failed (retries)', e.message));
    if (this.positionQty * (this.price || 1) > 0 && this.positionQty > 0) this.side = 'long';
    this.status = 'warming';
    this.stream.start();
    this.sampler.start();
    const p = this.model.lobPolicy!;
    this.log.ok(`fly awake (realtime) on ${this.symbol} — sub ${this.state.subaccountId}, equity ${this.equity.toFixed(2)} USDT, ${this.brain.N} neurons, H=${this.model.horizon}s θin ${p.thetaIn} θout ${p.thetaOut} hold ${p.minHoldSec}s maxFrac ${p.maxFrac}; observing ${120 + SETTLE}s before trading`);
  }

  stop(): void {
    this.sampler.stop();
    this.stream.stop();
    this.status = 'stopped';
    this.save();
  }

  private async ensureSubaccount(): Promise<void> {
    const path = this.statePath;
    if (existsSync(path)) {
      this.state = JSON.parse(readFileSync(path, 'utf8')) as LiveState;
      this.log.info(`resuming subaccount ${this.state.subaccountId} (${this.state.label})`);
      return;
    }
    const master = new MasterClient();
    await master.ensureAccount(config.master.email, config.master.password);
    const capital = this.opts.capital ?? config.capitalUsdt;
    const label = `${this.opts.label ?? `fly:${this.symbol}`}:${crypto.randomBytes(3).toString('hex')}`.toLowerCase();
    const sub = await master.createSubaccount(label);
    try {
      await master.deposit('USDT', String(capital));
      // 동시 입장 시 마스터 입금 반영 전 이체가 겹칠 수 있다 — 짧게 재시도
      for (let attempt = 1; ; attempt++) {
        try {
          await master.transfer(master.userId!, sub.id, 'USDT', String(capital));
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 1_000 * attempt));
        }
      }
      const key = await master.issueApiKey(sub.id, `${label} key`);
      this.state = { symbol: this.symbol, interval: '1s', label, subaccountId: sub.id, creds: { apiKey: key.apiKey, secret: key.secret }, capitalUsdt: capital, createdAt: Date.now(), equityCurve: [], actions: [] };
      this.save();
      this.log.ok(`subaccount ${sub.id} (${label}) funded ${capital} USDT`);
    } catch (e) {
      await master.transfer(sub.id, master.userId!, 'USDT', String(capital)).catch(() => {});
      throw e;
    }
  }

  private async refresh(): Promise<void> {
    const bals = await this.client.balances();
    const sum = (asset: string, free = false): number => bals.filter((b) => b.asset === asset).reduce((a, b) => a + Number(b.free) + (free ? 0 : Number(b.locked)), 0);
    this.quoteTotal = sum(this.spec.quoteAsset);
    this.quoteFree = sum(this.spec.quoteAsset, true);
    this.positionQty = sum(this.spec.baseAsset);
    this.baseFree = sum(this.spec.baseAsset, true);
    this.lastBalanceAt = Date.now();
    this.mark();
  }

  private mark(): void {
    this.equity = this.quoteTotal + this.positionQty * (this.price || 0);
  }

  private async onSample(s: LobSample): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.lastSample = s;
      this.samples++;
      this.price = midOf(s);
      this.mark();
      const f = this.fx.update(s);
      if (!f) return;
      this.brain.step(f);
      if (this.settled < 0) this.settled = this.samples;
      const yhat = predict(this.readout, pool(this.brain.descending(), this.model.readoutGroups ?? this.readout.dim));
      const p = this.model.lobPolicy!;
      const held = this.positionQty * this.price > this.equity * 0.01;
      if (held !== (this.side === 'long') && s.t - this.sideChangedAt > 30_000) {
        this.side = held ? 'long' : 'flat'; // 잔고가 30초 넘게 다르게 말하면 잔고가 진실
        this.sideChangedAt = s.t;
      }
      const exposure = this.side === 'long' ? 1 : 0;
      this.history.push({ t: s.t, yhat, exposure });
      if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
      this.snapshot = { t: s.t, price: this.price, yhat, yScale: this.model.yScale, exposure, populations: this.brain.activity(), descending: Array.from(this.brain.descending(), (v) => Math.round(v * 1000) / 1000), features: Array.from(f, (v) => Math.round(v * 1000) / 1000) };
      if (!this.warm) return;
      if (this.status === 'warming') {
        this.status = 'running';
        this.log.ok('warm — trading enabled');
      }
      let action: string | null = null;
      const long = exposure === 1;
      if (s.t - this.sideChangedAt < 3_000) {
        // 직전 주문 직후 — 새 주문 없음
      } else if (!long && yhat > p.thetaIn * this.model.yScale) {
        await this.refresh();
        const spend = Math.min(this.quoteFree, this.equity * p.maxFrac);
        if (spend >= this.spec.minNotional) {
          const o = await this.client.placeMarket(this.spec, 'BUY', '0', toFixedStr(spend));
          this.entryT = s.t;
          this.side = 'long';
          this.sideChangedAt = s.t;
          action = `BUY ${spend.toFixed(2)} USDT (ŷ ${yhat.toFixed(4)} > ${(p.thetaIn * this.model.yScale).toFixed(4)}) → order ${o.id} ${o.status}`;
        }
      } else if (long && yhat < p.thetaOut * this.model.yScale && (s.t - this.entryT) / 1000 >= p.minHoldSec) {
        await this.refresh();
        const qtyStr = floorQty(this.spec, this.baseFree);
        if (Number(qtyStr) > 0 && Number(qtyStr) * this.price >= this.spec.minNotional) {
          const o = await this.client.placeMarket(this.spec, 'SELL', qtyStr, '0');
          this.side = 'flat';
          this.sideChangedAt = s.t;
          action = `SELL ${qtyStr} (ŷ ${yhat.toFixed(4)} < ${(p.thetaOut * this.model.yScale).toFixed(4)}) → order ${o.id} ${o.status}`;
        }
      }
      if (action) {
        await new Promise((r) => setTimeout(r, 300)); // 엔진 비동기 체결 반영 대기
        await this.refresh();
        this.fills = await this.client.trades(this.symbol, 50).catch(() => this.fills);
        this.log.info(`${new Date(s.t).toISOString().slice(11, 19)} ${this.symbol} ${this.price.toFixed(2)} | ${action} | equity ${this.equity.toFixed(2)} pos ${this.positionQty}`);
        this.state.actions.push({ t: s.t, action, yhat, exposure: this.positionQty > 0 ? 1 : 0, price: this.price, equity: this.equity, positionQty: this.positionQty });
        if (this.state.actions.length > MAX_ACTIONS) this.state.actions.splice(0, this.state.actions.length - MAX_ACTIONS);
      } else if (Date.now() - this.lastBalanceAt > BALANCE_REFRESH_MS) {
        await this.refresh();
      }
      if (this.samples % 10 === 0) {
        this.state.equityCurve.push({ t: s.t, equity: this.equity });
        if (this.state.equityCurve.length > MAX_CURVE) this.state.equityCurve.splice(0, this.state.equityCurve.length - MAX_CURVE);
        this.save();
      }
      if (this.samples % 60 === 0) this.log.info(`${new Date(s.t).toISOString().slice(11, 19)} mid ${this.price.toFixed(2)} | ŷ ${yhat.toFixed(4)} (θin ${(p.thetaIn * this.model.yScale).toFixed(4)}) | ${long ? 'LONG' : 'flat'} | equity ${this.equity.toFixed(2)}`);
      this.consecutiveErrors = 0;
      this.lastError = null;
    } catch (e) {
      this.consecutiveErrors++;
      this.lastError = (e as Error).message;
      this.log.warn(`sample handling failed (${this.consecutiveErrors}x)`, this.lastError);
    } finally {
      this.busy = false;
      if (Date.now() - this.lastStatusAt >= 1_000) this.writeStatus();
    }
  }

  /** 시즌 종료·리그 정지: 포지션 청산 후 정지. */
  async retire(): Promise<string> {
    this.sampler.stop();
    this.stream.stop();
    const r = await this.flattenAll().catch((e: Error) => `flatten failed: ${e.message}`);
    await new Promise((r2) => setTimeout(r2, 500));
    await this.refresh().catch(() => {});
    this.status = 'stopped';
    this.save();
    this.writeStatus();
    return r;
  }

  /** 전량 매도. 직전 매수의 정산이 늦어 base가 아직 0/locked이면 잠시 기다린다 (강등 청산이 다음 파리에게 포지션을 넘기지 않도록). */
  async flattenAll(): Promise<string> {
    for (let attempt = 1; attempt <= 8; attempt++) {
      await this.refresh();
      const qtyStr = floorQty(this.spec, this.baseFree);
      if (Number(qtyStr) > 0 && Number(qtyStr) * (this.price || 1) >= this.spec.minNotional) {
        const o = await this.client.placeMarket(this.spec, 'SELL', qtyStr, '0');
        this.side = 'flat';
        return `FLATTEN ${qtyStr} → order ${o.id} ${o.status}`;
      }
      const settling = this.side === 'long' || this.positionQty > this.baseFree; // 매수 정산 대기 또는 locked
      if (!settling) return 'nothing to sell';
      await new Promise((r) => setTimeout(r, 1_500));
    }
    return 'nothing to sell (position not visible after 12s)';
  }

  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  /** 리그 매니저용 상태 파일 (원자적 교체). */
  private writeStatus(): void {
    if (!this.opts.statusPath) return;
    const tmp = `${this.opts.statusPath}.tmp`;
    mkdirSync(dirname(this.opts.statusPath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(this.view()));
    renameSync(tmp, this.opts.statusPath);
    this.lastStatusAt = Date.now();
  }

  view(): Record<string, unknown> {
    const m = this.model;
    const s = this.lastSample;
    return {
      mode: 'lob',
      label: this.state?.label ?? null,
      symbol: this.symbol,
      interval: '1s',
      status: this.status,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
      subaccountId: this.state.subaccountId,
      capitalUsdt: this.state.capitalUsdt,
      equity: this.equity,
      quoteTotal: this.quoteTotal,
      positionQty: this.positionQty,
      price: this.price,
      lastBarTime: s?.t ?? null,
      barsSeen: this.samples,
      warm: this.warm,
      policy: { ...m.lobPolicy, thetaInAbs: m.lobPolicy!.thetaIn * m.yScale, thetaOutAbs: m.lobPolicy!.thetaOut * m.yScale },
      book: s ? { bids: s.bids.slice(0, 10), asks: s.asks.slice(0, 10), trades: s.trades.length, depthMsgs: s.depthMsgs } : null,
      featureNames: m.features,
      model: { symbol: m.symbol, interval: m.interval, horizon: m.horizon, trainedAt: m.trainedAt, valIc: m.train.val.best.ic, valHitRate: m.train.val.best.hitRate, neurons: m.connectome.N, synapses: m.connectome.E, region: m.connectome.region, brain: m.brain, evo: m.evo ?? null },
      snapshot: this.snapshot,
      history: this.history,
      equityCurve: this.state.equityCurve.slice(-2000),
      actions: this.state.actions.slice(-100).reverse(),
      fills: this.fills.slice(0, 50),
    };
  }
}

export type { ActionLog, EquityPoint };
