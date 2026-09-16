import { fetchHistory } from '../core/binance';
import type { Logger } from '../core/logger';
import type { Bar } from '../core/types';
import { DEFAULT_BRAIN, FlyBrain, type BrainParams } from './brain';
import { Connectome } from './connectome';
import { BAR_FEATURES, BarFeatures } from './features';
import { type FlyModel, type LambdaScore, type ValidationReport, saveModel } from './model';
import { connectomePath, modelPath } from './paths';
import { RidgeAccumulator, correlation, predict, type Readout } from './readout';

export interface TrainArgs {
  symbol: string;
  interval: string;
  from: number;
  to: number;
  horizon?: number;
  region?: 'central' | 'full';
  brain?: Partial<BrainParams>;
  /** 마지막 이 비율의 행을 λ 선택용 검증으로 (시간순, 지평만큼 purge). */
  valFrac?: number;
  lambdas?: number[];
  /** 피처가 준비된 뒤 뇌 상태가 자리잡을 때까지 버리는 bar 수. */
  settleBars?: number;
}

const DEFAULT_LAMBDAS = [1e-4, 1e-3, 1e-2, 1e-1, 1];

/** 예측 타깃: 지평 H bar 로그수익률을 현재 변동성으로 정규화해 유계로 눌러 둔다. */
export function target(closeNow: number, closeAhead: number, sigma: number, horizon: number): number {
  return Math.tanh(Math.log(closeAhead / closeNow) / (Math.max(sigma, 1e-8) * Math.sqrt(horizon)) / 2);
}

function score(readout: Readout, xs: Float32Array[], ys: number[], lambda: number): LambdaScore {
  const yhat = xs.map((x) => predict(readout, x));
  let hits = 0;
  let signed = 0;
  for (let i = 0; i < ys.length; i++) {
    if (ys[i] === 0) continue;
    signed++;
    if (Math.sign(yhat[i]!) === Math.sign(ys[i]!)) hits++;
  }
  const order = yhat.map((v, i) => i).sort((a, b) => yhat[b]! - yhat[a]!);
  const top = order.slice(0, Math.max(1, Math.floor(order.length / 5)));
  const topMean = top.reduce((s, i) => s + ys[i]!, 0) / top.length;
  return { lambda, ic: correlation(yhat, ys), hitRate: signed ? hits / signed : 0, topQuintileMeanY: topMean };
}

/**
 * 뇌를 Binance 이력 위로 한 번 살게 하며 (bar → 피처 → 감각뉴런 → 전파) 하강뉴런 상태와 미래 수익률
 * 타깃을 모아 ridge 판독을 맞춘다. 뇌는 건드리지 않는다 — 학습되는 것은 판독 벡터 하나.
 */
export async function trainFly(args: TrainArgs, log: Logger): Promise<{ model: FlyModel; path: string }> {
  const region = args.region ?? 'central';
  const horizon = args.horizon ?? 15;
  const brainParams: BrainParams = { ...DEFAULT_BRAIN, ...args.brain };
  const valFrac = args.valFrac ?? 0.25;
  const lambdas = args.lambdas ?? DEFAULT_LAMBDAS;
  const settle = args.settleBars ?? 200;

  const conn = Connectome.load(connectomePath(region));
  const brain = new FlyBrain(conn, brainParams, BAR_FEATURES);
  log.info(`brain: ${conn.N} neurons, ${conn.E} synapses (${region}); ${brain.inputNeurons} sensory inputs → ${brain.readoutDim} descending neurons`);

  log.info(`fetching ${args.symbol} ${args.interval} ${new Date(args.from).toISOString()} → ${new Date(args.to).toISOString()} from Binance …`);
  const bars: Bar[] = await fetchHistory(args.symbol, args.interval, args.from, args.to);
  if (bars.length < settle + horizon + 500) throw new Error(`only ${bars.length} bars — need at least ${settle + horizon + 500}; widen the range`);
  log.info(`${bars.length} bars; running the fly over history (horizon ${horizon} bars) …`);

  // 1. live the history: collect DN states + targets
  const fx = new BarFeatures();
  const xs: Float32Array[] = [];
  const ys: number[] = [];
  let warmSince = -1;
  // echo-state 자가 점검: 다른 초기 상태에서 출발한 쌍둥이 뇌가 settle 구간 뒤 같은 곳에 있어야 한다
  let probe: FlyBrain | null = new FlyBrain(conn, brainParams, BAR_FEATURES);
  probe.h.fill(0.3);
  let echoDiff = NaN;
  const t0 = Date.now();
  for (let t = 0; t < bars.length; t++) {
    const bar = bars[t]!;
    const f = fx.update(bar);
    if (!f) continue;
    brain.step(f);
    if (warmSince < 0) warmSince = t;
    if (t - warmSince < settle) {
      probe?.step(f);
      continue;
    }
    if (probe) {
      probe.step(f); // 같은 bar 수를 밟은 뒤 비교
      echoDiff = 0;
      const a = brain.descending();
      const b = probe.descending();
      for (let i = 0; i < a.length; i++) echoDiff = Math.max(echoDiff, Math.abs(a[i]! - b[i]!));
      probe = null;
      (echoDiff > 1e-3 ? log.warn : log.info)(`echo-state check after ${settle} bars: max|Δ descending| = ${echoDiff.toExponential(2)}${echoDiff > 1e-3 ? ' — brain state depends on init; lower gain/normP' : ''}`);
    }
    if (t + horizon >= bars.length) break;
    xs.push(Float32Array.from(brain.descending()));
    ys.push(target(bar.close, bars[t + horizon]!.close, fx.vol, horizon));
    if (xs.length % 2000 === 0) {
      const ms = (Date.now() - t0) / (t + 1);
      log.info(`  ${t + 1}/${bars.length} bars, ${xs.length} rows, ${ms.toFixed(1)} ms/bar, ETA ${Math.round(((bars.length - t) * ms) / 1000)}s`);
    }
  }
  const msPerBar = (Date.now() - t0) / bars.length;
  const d = brain.readoutDim;
  const nVal = Math.floor(xs.length * valFrac);
  const nTrain = xs.length - nVal - horizon; // purge: 겹치는 지평의 행은 어느 쪽에도 넣지 않는다
  if (nTrain < d) log.warn(`only ${nTrain} training rows for ${d} readout dims — ridge will lean on λ`);
  log.info(`${xs.length} rows (${nTrain} train / ${nVal} val) in ${((Date.now() - t0) / 1000).toFixed(0)}s; fitting readout …`);

  // 2. λ grid on the validation tail
  const acc = new RidgeAccumulator(d);
  for (let i = 0; i < nTrain; i++) acc.add(xs[i]!, ys[i]!);
  const valX = xs.slice(xs.length - nVal);
  const valY = ys.slice(ys.length - nVal);
  const grid: LambdaScore[] = [];
  for (const lambda of lambdas) {
    const s = score(acc.solve(lambda), valX, valY, lambda);
    grid.push(s);
    log.info(`  λ=${lambda}: val IC ${s.ic.toFixed(4)} hit ${(s.hitRate * 100).toFixed(1)}% top-quintile ȳ ${s.topQuintileMeanY.toFixed(4)}`);
  }
  const best = grid.reduce((a, b) => (b.ic > a.ic ? b : a));
  const val: ValidationReport = { rows: nVal, meanY: valY.reduce((a, b) => a + b, 0) / Math.max(1, nVal), best, grid };

  // 3. final readout on every row with the chosen λ
  for (let i = nTrain; i < xs.length; i++) acc.add(xs[i]!, ys[i]!);
  const readout = acc.solve(best.lambda);
  const yhatAll = xs.map((x) => predict(readout, x));
  const inSampleIc = correlation(yhatAll, ys);
  const positives = yhatAll.filter((v) => v > 0).sort((a, b) => a - b);
  const pool = positives.length >= 20 ? positives : yhatAll.map(Math.abs).sort((a, b) => a - b);
  const yScale = Math.max(pool[Math.floor(pool.length * 0.8)] ?? 1e-3, 1e-6);

  const model: FlyModel = {
    version: 1,
    kind: 'flybrain',
    symbol: args.symbol.toUpperCase(),
    inputKind: 'bars',
    interval: args.interval,
    horizon,
    connectome: { region, N: conn.N, E: conn.E, builtAt: conn.meta.builtAt },
    brain: brainParams,
    features: BAR_FEATURES.map((f) => f.name),
    readout: { dim: d, b: readout.b, w: Array.from(readout.w) },
    yScale,
    trainedAt: new Date().toISOString(),
    train: { from: args.from, to: args.to, bars: bars.length, rows: xs.length, lambda: best.lambda, val, inSampleIc, msPerBar, echoDiff },
  };
  const path = modelPath(model.symbol, model.interval);
  saveModel(path, model);
  log.ok(`model → ${path} (λ=${best.lambda}, val IC ${best.ic.toFixed(4)}, in-sample IC ${inSampleIc.toFixed(4)}, yScale ${yScale.toExponential(2)})`);
  return { model, path };
}
