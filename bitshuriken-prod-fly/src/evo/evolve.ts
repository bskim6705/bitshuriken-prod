import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config';
import type { Logger } from '../core/logger';
import { Connectome } from '../brain/connectome';
import { type FlyModel, saveModel } from '../brain/model';
import { buildLobModel } from './build-model';
import { connectomePath, flyDir, modelPath } from '../brain/paths';
import { describeRecording, loadRecording } from '../lob/replay';
import type { EvalResult } from './evaluate';
import { type Genome, baseGenome, mutate, rng } from './genome';

export interface EvolveArgs {
  symbol: string;
  generations: number;
  population: number;
  elite: number;
  workers: number;
  minTrades: number;
  trainFrac: number;
  seed: number;
  region: 'central' | 'full';
  /** 이전 실행의 최종 세대에서 이어가기. */
  resume: boolean;
  /** 실행 이름 — data/evo/<SYMBOL>/<run>/. 기본은 타임스탬프. */
  run: string;
}

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));

function runWorker(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(TSX, [WORKER, ...args], { maxBuffer: 1 << 20 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`worker failed: ${stderr || err.message}`));
      else resolve();
    });
  });
}

async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let it = queue.shift(); it !== undefined; it = queue.shift()) await fn(it);
  }));
}

const evoDir = (symbol: string, run: string): string => join(flyDir(), 'evo', symbol.toUpperCase(), run);

/**
 * 단순 유전 선별: 세대마다 파리 전부를 기록 위에서 평가 → 적합도(뒤쪽 미학습 구간 순수익 + 승률) 상위 elite 보존 →
 * 나머지는 엘리트의 돌연변이 + 신입 1마리. 최종 최우수 파리를 lob 모델(data/models/<SYMBOL>-1s.json)로 저장한다.
 */
export async function evolve(a: EvolveArgs, log: Logger): Promise<FlyModel> {
  const samples = loadRecording(a.symbol);
  const desc = describeRecording(samples);
  if (desc.rows < 1200) throw new Error(`recording too short (${desc.rows} samples) — let \`npm run fly record ${a.symbol}\` run for at least 20 minutes`);
  log.info(`recording: ${desc.rows} samples (${desc.hours.toFixed(2)}h, ${desc.segments} segment${desc.segments > 1 ? 's' : ''}) ${new Date(desc.from).toISOString()} → ${new Date(desc.to).toISOString()}`);
  const conn = Connectome.load(connectomePath(a.region));
  const r = rng(a.seed);
  const dir = evoDir(a.symbol, a.run);
  mkdirSync(dir, { recursive: true });
  log.info(`run dir ${dir}`);
  const opts = { takerFeeBps: config.takerFeeBps, trainFrac: a.trainFrac, minTrades: a.minTrades, region: a.region };
  log.info(`fitness: taker fee ${opts.takerFeeBps}bps, train ${Math.round(a.trainFrac * 100)}% / test ${Math.round((1 - a.trainFrac) * 100)}%, min ${a.minTrades} trades; ${a.population} flies × ${a.generations} generations, ${a.workers} workers`);

  // 초기 세대: 기본형 1 + 강한 돌연변이
  let population: Genome[] = [];
  let startGen = 0;
  const statePath = join(dir, 'population.json');
  if (a.resume && existsSync(statePath)) {
    const st = JSON.parse(readFileSync(statePath, 'utf8')) as { generation: number; population: Genome[] };
    population = st.population;
    startGen = st.generation + 1;
    log.info(`resuming from generation ${st.generation} (${population.length} flies)`);
  } else {
    const base = baseGenome('g0-f0');
    population = [base];
    for (let i = 1; i < a.population; i++) population.push(mutate(base, `g0-f${i}`, r, 2));
  }

  let best: EvalResult | null = null;
  let bestGenome: Genome | null = null;
  for (let gen = startGen; gen < startGen + a.generations; gen++) {
    const genDir = join(dir, `gen-${String(gen).padStart(2, '0')}`);
    mkdirSync(genDir, { recursive: true });
    const t0 = Date.now();
    const results = new Map<string, EvalResult>();
    await pooled(population, a.workers, async (g) => {
      const gp = join(genDir, `${g.id}.genome.json`);
      const rp = join(genDir, `${g.id}.result.json`);
      writeFileSync(gp, JSON.stringify(g));
      try {
        await runWorker([gp, rp, a.symbol, JSON.stringify(opts)]);
        results.set(g.id, JSON.parse(readFileSync(rp, 'utf8')) as EvalResult);
      } catch (e) {
        log.warn(`${g.id} evaluation failed`, (e as Error).message.slice(0, 300));
      }
    });
    const ranked = [...results.values()].sort((x, y) => y.fitness - x.fitness);
    if (!ranked.length) throw new Error('every fly failed to evaluate');
    const fmt = (e: EvalResult): string =>
      `${e.id.padEnd(9)} fit ${e.valid ? e.fitness.toFixed(3).padStart(7) : '  (n/a)'} | net ${e.netReturnPct.toFixed(3).padStart(7)}% (b&h ${e.buyHoldPct.toFixed(3)}%) win ${(e.winRate * 100).toFixed(0).padStart(3)}% trades ${String(e.trades).padStart(3)} hold ${e.avgHoldSec.toFixed(0).padStart(4)}s exp ${(e.exposure * 100).toFixed(0).padStart(3)}% | IC test ${e.icTest.toFixed(3)} train ${e.icTrain.toFixed(3)} | dim ${e.readout.dim}`;
    log.ok(`generation ${gen} — ${ranked.length} flies in ${((Date.now() - t0) / 1000).toFixed(0)}s (${ranked[0]!.msPerSample.toFixed(1)} ms/sample/fly)`);
    for (const e of ranked.slice(0, Math.max(a.elite, 5))) log.info(`  ${fmt(e)}`);
    writeFileSync(join(genDir, 'ranking.json'), JSON.stringify(ranked, null, 2));
    const top = ranked[0]!;
    if (top.valid && (!best || top.fitness > best.fitness)) {
      best = top;
      bestGenome = population.find((g) => g.id === top.id) ?? null;
    }
    // 다음 세대: 엘리트 보존 + 엘리트 돌연변이 + 신입 1
    const elites = ranked.filter((e) => e.valid).slice(0, a.elite).map((e) => population.find((g) => g.id === e.id)!);
    const parents = elites.length ? elites : ranked.slice(0, a.elite).map((e) => population.find((g) => g.id === e.id)!);
    const next: Genome[] = parents.map((g) => ({ ...g }));
    let k = 0;
    while (next.length < a.population - 1) {
      const parent = parents[k++ % parents.length]!;
      next.push(mutate(parent, `g${gen + 1}-f${next.length}`, r));
    }
    next.push(mutate(baseGenome(`g${gen + 1}-f${next.length}`), `g${gen + 1}-f${next.length}`, r, 2));
    population = next;
    writeFileSync(statePath, JSON.stringify({ generation: gen, population, best: best?.id ?? null }, null, 2));
  }
  if (!best || !bestGenome) throw new Error(`no fly traded at least ${a.minTrades} times in the test window — record longer or lower minTrades`);

  const model = buildLobModel(a.symbol, bestGenome, best, conn, desc, Number(best.id.slice(1).split('-')[0]));
  const path = modelPath(model.symbol, '1s');
  saveModel(path, model);
  saveModel(join(dir, 'best.model.json'), model);
  log.ok(`best fly ${best.id}: net ${best.netReturnPct.toFixed(3)}% win ${(best.winRate * 100).toFixed(0)}% over ${best.trades} trades (test IC ${best.icTest.toFixed(3)}) → ${path}`);
  return model;
}
