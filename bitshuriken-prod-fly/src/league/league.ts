import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config';
import type { Logger } from '../core/logger';
import { Connectome } from '../brain/connectome';
import { type FlyModel, saveModel } from '../brain/model';
import { connectomePath, flyDir } from '../brain/paths';
import { describeRecording, loadRecording } from '../lob/replay';
import { buildLobModel } from '../evo/build-model';
import type { EvalResult } from '../evo/evaluate';
import { type Genome, baseGenome, mutate, rng } from '../evo/genome';
import type { SlotFile } from './worker';

export interface LeagueArgs {
  symbol: string;
  flies: number;
  seasonMin: number;
  relegate: number;
  minTrades: number; // 시즌 중 주문(매수+매도) 최소 수 — 미달은 최하위(실격)
  capital: number; // 파리당 USDT
  seedFrom?: string; // data/evo/<SYMBOL>/<run>/population.json 에서 초기 유전자
  workers: number; // 판독 재적합 병렬 수
  seed: number;
  /** 판독 재적합에 쓰는 기록 길이(시간). 느린 기계에서 시즌보다 오래 걸리지 않게 최근 구간만 쓴다. */
  fitWindowHours: number;
}

export interface FlyEntry {
  slot: number;
  id: string;
  parent: string | null;
  genome: Genome;
  born: number; // 입장 시즌
  modelPath: string;
  qualifier: { icTest: number; netReturnPct: number; trades: number } | null;
}

export interface Standing {
  rank: number;
  /** 최근 equity 곡선 (10초 간격, 최대 180점) — FE 그래프용. */
  sparkline: { t: number; equity: number }[];
  slot: number;
  id: string;
  parent: string | null;
  born: number;
  seasons: number;
  status: string;
  equity: number;
  seasonStartEquity: number;
  seasonPnlPct: number;
  lifetimePnlPct: number;
  capital: number;
  ordersSeason: number;
  winRate: number;
  yhat: number | null;
  exposure: number;
  positionQty: number;
  price: number;
  lastAction: string | null;
  active: boolean;
  relegationZone: boolean;
}

interface SeasonRecord {
  season: number;
  endedAt: number;
  table: Standing[];
  relegated: string[];
  newborn: { id: string; parent: string; slot: number }[];
}

interface LeagueState {
  symbol: string;
  capital: number;
  seasonMs: number;
  relegate: number;
  minTrades: number;
  season: number;
  seasonStartedAt: number;
  slots: { slot: number; statePath: string; statusPath: string; label: string }[];
  flies: FlyEntry[];
  seasonStartEquity: Record<string, number>;
  history: SeasonRecord[];
  hallOfFame: { bestSeason: { id: string; pnlPct: number; season: number } | null; longestSurvivor: { id: string; seasons: number } | null; champions: Record<string, number> };
}

const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
const FLY_WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));
const EVAL_WORKER = fileURLToPath(new URL('../evo/worker.ts', import.meta.url));
const TICK_MS = 5_000;
const RETIRE_TIMEOUT_MS = 25_000;

const leagueDir = (symbol: string): string => join(flyDir(), 'league', symbol.toUpperCase());

/**
 * 트레이딩 컴피티션: N마리가 같은 자본·같은 수수료로 동시에 라이브 거래한다. 시즌마다 시즌 순수익 순위를 매기고
 * 하위 relegate마리는 탈락(청산)한다. 빈 자리엔 상위 파리의 돌연변이가 입장한다 — 판독은 최신 기록으로 재적합.
 * 시즌 중 주문이 minTrades 미만이면 순위 최하위(실격) — 거래 회피는 살아남지 못한다 (feedback-031).
 */
export class League {
  state!: LeagueState;
  private readonly children = new Map<number, ChildProcess>();
  private readonly crashes = new Map<number, number>();
  private timer: NodeJS.Timeout | null = null;
  private ending = false;
  private stopped = false;
  private conn!: Connectome;
  private readonly r: () => number;

  constructor(
    readonly a: LeagueArgs,
    private readonly log: Logger,
  ) {
    this.r = rng(a.seed);
  }

  get dir(): string {
    return leagueDir(this.a.symbol);
  }

  async start(): Promise<void> {
    this.conn = Connectome.load(connectomePath('central'));
    mkdirSync(join(this.dir, 'flies'), { recursive: true });
    mkdirSync(join(this.dir, 'status'), { recursive: true });
    mkdirSync(join(this.dir, 'logs'), { recursive: true });
    const statePath = join(this.dir, 'league.json');
    if (existsSync(statePath)) {
      this.state = JSON.parse(readFileSync(statePath, 'utf8')) as LeagueState;
      this.log.info(`resuming league: season ${this.state.season}, ${this.state.flies.length} flies`);
    } else {
      this.state = {
        symbol: this.a.symbol,
        capital: this.a.capital,
        seasonMs: this.a.seasonMin * 60_000,
        relegate: this.a.relegate,
        minTrades: this.a.minTrades,
        season: 1,
        seasonStartedAt: Date.now(),
        slots: Array.from({ length: this.a.flies }, (_, i) => ({
          slot: i,
          statePath: join(this.dir, `slot-${i}.live.json`),
          statusPath: join(this.dir, 'status', `slot-${i}.json`),
          label: `fly:league:${this.a.symbol}:s${i}`,
        })),
        flies: [],
        seasonStartEquity: {},
        history: [],
        hallOfFame: { bestSeason: null, longestSurvivor: null, champions: {} },
      };
      const genomes = this.initialGenomes();
      this.log.info(`qualifying ${genomes.length} flies (readout fit on the recording) …`);
      const fitted = await this.fitAll(genomes);
      this.state.flies = fitted.map((f, i) => ({ slot: i, id: f.genome.id, parent: f.genome.parent, genome: f.genome, born: 1, modelPath: f.modelPath, qualifier: f.qualifier }));
      for (const s of this.state.slots) this.state.seasonStartEquity[String(s.slot)] = this.a.capital;
      this.save();
    }
    // 시즌 시계는 파리가 실제로 입장할 때 시작한다 (예선·재시작 시간은 시즌에 넣지 않는다)
    this.state.seasonStartedAt = Date.now();
    for (const s of this.state.slots) {
      const st = this.readStatus(s.slot);
      const eq = Number(st?.equity ?? 0);
      if (eq > 0) this.state.seasonStartEquity[String(s.slot)] = eq;
    }
    this.save();
    for (const f of this.state.flies) {
      this.spawnFly(f);
      await new Promise((r) => setTimeout(r, 1_500)); // 마스터 입금→이체가 겹치지 않게
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.log.ok(`league on ${this.a.symbol}: ${this.state.flies.length} flies, season ${this.a.seasonMin}min, relegate ${this.state.relegate}, min ${this.state.minTrades} orders, ${this.a.capital} USDT each`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.log.info('stopping league — retiring every fly (flatten) …');
    await Promise.all([...this.children.keys()].map((slot) => this.retire(slot)));
    this.save();
  }

  // ---- population ----
  private initialGenomes(): Genome[] {
    const n = this.a.flies;
    const out: Genome[] = [];
    if (this.a.seedFrom) {
      const p = join(flyDir(), 'evo', this.a.symbol.toUpperCase(), this.a.seedFrom, 'population.json');
      if (existsSync(p)) {
        const pop = (JSON.parse(readFileSync(p, 'utf8')) as { population: Genome[] }).population;
        for (const g of pop.slice(0, n)) out.push({ ...g, id: `s1-${out.length}`, parent: g.id });
        this.log.info(`seeded ${out.length} genomes from evolve run ${this.a.seedFrom}`);
      } else this.log.warn(`seedFrom ${this.a.seedFrom}: ${p} not found — starting fresh`);
    }
    if (!out.length) out.push(baseGenome('s1-0'));
    while (out.length < n) out.push(mutate(out[0]!, `s1-${out.length}`, this.r, 1.5));
    return out;
  }

  /** 유전자 → 기록 위 평가(=판독 재적합) → 모델 파일. 병렬 풀. */
  private async fitAll(genomes: Genome[]): Promise<{ genome: Genome; modelPath: string; qualifier: FlyEntry['qualifier'] }[]> {
    const from = Date.now() - this.a.fitWindowHours * 3_600_000;
    const samples = loadRecording(this.a.symbol, { from });
    const desc = describeRecording(samples);
    if (desc.rows < 600) throw new Error(`recording too short (${desc.rows}s in the last ${this.a.fitWindowHours}h) — run \`npm run fly record ${this.a.symbol}\` first`);
    const opts = JSON.stringify({ takerFeeBps: config.takerFeeBps, trainFrac: 0.7, minTrades: 1, region: 'central', from });
    this.log.info(`readout fit window: ${desc.rows} samples (${desc.hours.toFixed(2)}h)`);
    const out: { genome: Genome; modelPath: string; qualifier: FlyEntry['qualifier'] }[] = [];
    const queue = [...genomes];
    await Promise.all(
      Array.from({ length: Math.min(this.a.workers, queue.length) }, async () => {
        for (let g = queue.shift(); g !== undefined; g = queue.shift()) {
          const gp = join(this.dir, 'flies', `${g.id}.genome.json`);
          const rp = join(this.dir, 'flies', `${g.id}.eval.json`);
          writeFileSync(gp, JSON.stringify(g));
          await new Promise<void>((resolve, reject) => {
            execFile(TSX, [EVAL_WORKER, gp, rp, this.a.symbol, opts], { maxBuffer: 1 << 20 }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
          });
          const res = JSON.parse(readFileSync(rp, 'utf8')) as EvalResult;
          if (!res.readout.w.length) throw new Error(`${g.id}: readout fit failed (rows ${res.rows})`);
          const model = buildLobModel(this.a.symbol, g, res, this.conn, desc, this.state.season);
          const mp = join(this.dir, 'flies', `${g.id}.model.json`);
          saveModel(mp, model);
          out.push({ genome: g, modelPath: mp, qualifier: { icTest: res.icTest, netReturnPct: res.netReturnPct, trades: res.trades } });
          this.log.info(`  ${g.id.padEnd(8)} qualified: replay test IC ${res.icTest.toFixed(3)}, net ${res.netReturnPct.toFixed(3)}% over ${res.trades} trades, dim ${res.readout.dim}`);
        }
      }),
    );
    return out;
  }

  // ---- processes ----
  private spawnFly(f: FlyEntry): void {
    const slot = this.state.slots[f.slot]!;
    const model = JSON.parse(readFileSync(f.modelPath, 'utf8')) as FlyModel;
    const slotFile: SlotFile = { symbol: this.a.symbol, slot: f.slot, flyId: f.id, model, capital: this.a.capital, statePath: slot.statePath, statusPath: slot.statusPath, label: slot.label };
    const sp = join(this.dir, `slot-${f.slot}.json`);
    writeFileSync(sp, JSON.stringify(slotFile));
    const logFd = openSync(join(this.dir, 'logs', `slot-${f.slot}.log`), 'a');
    const child = spawn(TSX, [FLY_WORKER, sp], { stdio: ['ignore', logFd, logFd] });
    this.children.set(f.slot, child);
    child.on('exit', (code) => {
      if (this.children.get(f.slot) !== child) return;
      this.children.delete(f.slot);
      if (this.stopped || this.ending) return;
      const n = (this.crashes.get(f.slot) ?? 0) + 1;
      this.crashes.set(f.slot, n);
      this.log.warn(`slot ${f.slot} (${f.id}) exited with ${code} — respawn ${n}`);
      if (n <= 5) setTimeout(() => this.spawnFly(f), 5_000);
    });
    this.log.info(`slot ${f.slot} ← ${f.id} (parent ${f.parent ?? '—'}, H=${f.genome.horizonSec}s θ ${f.genome.policy.thetaIn.toFixed(2)}/${f.genome.policy.thetaOut.toFixed(2)} hold ${f.genome.policy.minHoldSec}s dim ${f.genome.readoutGroups})`);
  }

  /** SIGTERM → 워커가 청산 후 종료. */
  private retire(slot: number): Promise<void> {
    const child = this.children.get(slot);
    if (!child) return Promise.resolve();
    this.children.delete(slot);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, RETIRE_TIMEOUT_MS);
      child.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  // ---- standings ----
  private readStatus(slot: number): Record<string, unknown> | null {
    try {
      return JSON.parse(readFileSync(this.state.slots[slot]!.statusPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  standings(): Standing[] {
    const since = this.state.seasonStartedAt;
    const rows: Standing[] = this.state.flies.map((f) => {
      const st = this.readStatus(f.slot);
      const actions = ((st?.actions as { t: number; action: string; price: number }[] | undefined) ?? []).filter((a) => a.t >= since && /^(BUY|SELL)/.test(a.action));
      let buys = 0;
      let sells = 0;
      let wins = 0;
      let lastBuy: number | null = null;
      for (const a of [...actions].reverse()) {
        if (a.action.startsWith('BUY')) {
          buys++;
          lastBuy = a.price;
        } else {
          sells++;
          if (lastBuy !== null && a.price > lastBuy * (1 + (2 * config.takerFeeBps) / 1e4)) wins++;
          lastBuy = null;
        }
      }
      const equity = Number(st?.equity ?? 0) || this.state.seasonStartEquity[String(f.slot)] || this.a.capital;
      const startEq = this.state.seasonStartEquity[String(f.slot)] ?? this.a.capital;
      const snap = st?.snapshot as { yhat?: number; exposure?: number } | null | undefined;
      const lastAct = (st?.actions as { action: string }[] | undefined)?.[0]?.action ?? null;
      const curve = ((st?.equityCurve as { t: number; equity: number }[] | undefined) ?? []).slice(-180);
      return {
        rank: 0,
        sparkline: curve,
        slot: f.slot,
        id: f.id,
        parent: f.parent,
        born: f.born,
        seasons: this.state.season - f.born + 1,
        status: String(st?.status ?? 'starting'),
        equity,
        seasonStartEquity: startEq,
        seasonPnlPct: startEq > 0 ? (equity / startEq - 1) * 100 : 0,
        lifetimePnlPct: (equity / this.a.capital - 1) * 100,
        capital: this.a.capital,
        ordersSeason: buys + sells,
        winRate: sells ? wins / sells : 0,
        yhat: snap?.yhat ?? null,
        exposure: snap?.exposure ?? 0,
        positionQty: Number(st?.positionQty ?? 0),
        price: Number(st?.price ?? 0),
        lastAction: lastAct,
        active: buys + sells >= this.state.minTrades,
        relegationZone: false,
      };
    });
    // 순위: 활동 파리 수익순 → 실격(무거래) 파리 수익순
    rows.sort((x, y) => Number(y.active) - Number(x.active) || y.seasonPnlPct - x.seasonPnlPct);
    rows.forEach((r, i) => {
      r.rank = i + 1;
      r.relegationZone = i >= rows.length - this.state.relegate;
    });
    return rows;
  }

  summary(): Record<string, unknown> {
    const table = this.standings();
    return {
      symbol: this.a.symbol,
      season: this.state.season,
      seasonStartedAt: this.state.seasonStartedAt,
      seasonMs: this.state.seasonMs,
      secondsLeft: Math.max(0, Math.round((this.state.seasonStartedAt + this.state.seasonMs - Date.now()) / 1000)),
      relegate: this.state.relegate,
      minTrades: this.state.minTrades,
      capital: this.a.capital,
      takerFeeBps: config.takerFeeBps,
      ending: this.ending,
      table,
      history: this.state.history.slice(-12).reverse(),
      hallOfFame: this.state.hallOfFame,
      flies: this.state.flies.map((f) => ({ slot: f.slot, id: f.id, parent: f.parent, born: f.born, qualifier: f.qualifier, genome: { horizonSec: f.genome.horizonSec, readoutGroups: f.genome.readoutGroups, lambda: f.genome.lambda, policy: f.genome.policy, brain: f.genome.brain } })),
    };
  }

  flyStatus(slot: number): Record<string, unknown> | null {
    return this.readStatus(slot);
  }

  // ---- seasons ----
  private async tick(): Promise<void> {
    if (this.ending || this.stopped) return;
    if (Date.now() < this.state.seasonStartedAt + this.state.seasonMs) return;
    this.ending = true;
    try {
      await this.endSeason();
    } catch (e) {
      this.log.err(`season end failed: ${(e as Error).message}`);
    } finally {
      this.ending = false;
    }
  }

  private async endSeason(): Promise<void> {
    const table = this.standings();
    const season = this.state.season;
    this.log.ok(`season ${season} over — standings:`);
    for (const r of table) {
      this.log.info(`  #${r.rank} ${r.id.padEnd(8)} ${r.seasonPnlPct >= 0 ? '+' : ''}${r.seasonPnlPct.toFixed(3)}% (life ${r.lifetimePnlPct >= 0 ? '+' : ''}${r.lifetimePnlPct.toFixed(2)}%) orders ${r.ordersSeason} win ${(r.winRate * 100).toFixed(0)}%${r.active ? '' : ' — INACTIVE (disqualified)'}${r.relegationZone ? ' ↓' : ''}`);
    }
    const relegated = table.filter((r) => r.relegationZone);
    const survivors = table.filter((r) => !r.relegationZone);
    // 명예의 전당
    const champ = table[0]!;
    const hof = this.state.hallOfFame;
    if (champ.active && (!hof.bestSeason || champ.seasonPnlPct > hof.bestSeason.pnlPct)) hof.bestSeason = { id: champ.id, pnlPct: champ.seasonPnlPct, season };
    hof.champions[champ.id] = (hof.champions[champ.id] ?? 0) + 1;
    for (const r of table) if (!hof.longestSurvivor || r.seasons > hof.longestSurvivor.seasons) hof.longestSurvivor = { id: r.id, seasons: r.seasons };

    // 탈락: 청산 후 종료
    await Promise.all(relegated.map((r) => this.retire(r.slot)));
    // 입장: 상위 생존 파리의 돌연변이 (라운드로빈), 판독은 최신 기록으로 재적합
    const parents = survivors.length ? survivors : table;
    const newbornGenomes: Genome[] = relegated.map((r, i) => {
      const parentRow = parents[i % parents.length]!;
      const parent = this.state.flies.find((f) => f.slot === parentRow.slot)!;
      return mutate(parent.genome, `s${season + 1}-${r.slot}`, this.r);
    });
    const fitted = newbornGenomes.length ? await this.fitAll(newbornGenomes) : [];
    const newborn: SeasonRecord['newborn'] = [];
    for (let i = 0; i < relegated.length; i++) {
      const slot = relegated[i]!.slot;
      const f = fitted.find((x) => x.genome.id === newbornGenomes[i]!.id)!;
      const entry: FlyEntry = { slot, id: f.genome.id, parent: f.genome.parent, genome: f.genome, born: season + 1, modelPath: f.modelPath, qualifier: f.qualifier };
      this.state.flies = this.state.flies.map((x) => (x.slot === slot ? entry : x));
      newborn.push({ id: entry.id, parent: entry.parent ?? '—', slot });
    }
    this.state.history.push({ season, endedAt: Date.now(), table, relegated: relegated.map((r) => r.id), newborn });
    // 새 시즌: 생존자는 현재 equity에서, 신입은 청산된 슬롯 잔고에서 시작
    this.state.season = season + 1;
    this.state.seasonStartedAt = Date.now();
    for (const r of table) {
      const st = this.readStatus(r.slot);
      this.state.seasonStartEquity[String(r.slot)] = Number(st?.equity ?? r.equity) || r.equity;
    }
    this.save();
    for (const n of newborn) {
      this.spawnFly(this.state.flies.find((f) => f.slot === n.slot)!);
      await new Promise((r) => setTimeout(r, 1_500));
    }
    this.log.ok(`season ${season + 1} started — relegated ${relegated.map((r) => r.id).join(', ') || '—'}; newborn ${newborn.map((n) => `${n.id}(←${n.parent})`).join(', ') || '—'}`);
  }

  private save(): void {
    writeFileSync(join(this.dir, 'league.json'), JSON.stringify(this.state, null, 2));
  }
}
