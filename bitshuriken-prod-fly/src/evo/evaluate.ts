import { FlyBrain } from '../brain/brain';
import type { Connectome } from '../brain/connectome';
import { RidgeAccumulator, correlation, pool, predict, type Readout } from '../brain/readout';
import { LOB_FEATURES, LobFeatures } from '../lob/features';
import { GAP_MS } from '../lob/replay';
import { type LobSample, mid as midOf } from '../lob/sample';
import type { Genome } from './genome';

/** 피처 준비 후 뇌가 자리잡을 때까지 버리는 샘플 수. 라이브 warmup(300)과 합이 맞아야 한다. */
export const SETTLE = 180;

export interface EvalResult {
  id: string;
  parent: string | null;
  fitness: number;
  valid: boolean;
  netReturnPct: number;
  buyHoldPct: number;
  winRate: number;
  trades: number;
  maxDrawdownPct: number;
  exposure: number;
  avgHoldSec: number;
  icTrain: number;
  icTest: number;
  rows: number;
  testRows: number;
  msPerSample: number;
  /** 배치용: 전 구간 재적합 판독 + ŷ 표준편차(정책 임계 단위). */
  readout: { dim: number; b: number; w: number[] };
  yScale: number;
}

export interface EvalOptions {
  takerFeeBps: number;
  trainFrac: number; // 시간순 앞 비율로 판독 학습
  minTrades: number;
}

interface Row {
  x: Float32Array;
  t: number;
  mid: number;
  bid: number;
  ask: number;
  sigma: number;
  seg: number;
}

/**
 * 파리 한 마리를 기록 위에 살게 하고(리플레이) 뒤쪽 미학습 구간에서 정책의 순손익·승률을 잰다.
 * 뇌는 유전자대로, 판독은 앞 구간 ridge, 정책은 임계(θ_in 진입 / θ_out 청산, 최소 보유). 체결은 터치(ask 매수, bid 매도)
 * + 테이커 수수료. 세그먼트 경계(기록 공백)에서는 상태를 리셋하고 포지션을 청산한다.
 */
export function evaluate(g: Genome, conn: Connectome, samples: LobSample[], o: EvalOptions): EvalResult {
  const t0 = Date.now();
  let brain = new FlyBrain(conn, g.brain, LOB_FEATURES);
  let fx = new LobFeatures();
  const rows: Row[] = [];
  let seg = 0;
  let warmSince = -1;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (i > 0 && s.t - samples[i - 1]!.t > GAP_MS) {
      seg++;
      brain = new FlyBrain(conn, g.brain, LOB_FEATURES);
      fx = new LobFeatures();
      warmSince = -1;
    }
    const f = fx.update(s);
    if (!f) continue;
    brain.step(f);
    if (warmSince < 0) warmSince = i;
    if (i - warmSince < SETTLE) continue;
    rows.push({ x: pool(brain.descending(), g.readoutGroups), t: s.t, mid: midOf(s), bid: s.bids[0]![0], ask: s.asks[0]![0], sigma: fx.vol, seg });
  }
  const msPerSample = (Date.now() - t0) / Math.max(1, samples.length);
  const H = g.horizonSec;
  // 타깃: 같은 세그먼트 안에서 H초 뒤 mid
  const ys = new Float64Array(rows.length).fill(NaN);
  for (let i = 0; i < rows.length; i++) {
    const j = i + H;
    if (j < rows.length && rows[j]!.seg === rows[i]!.seg && rows[j]!.t - rows[i]!.t <= H * 1000 + 5_000) {
      ys[i] = Math.tanh(Math.log(rows[j]!.mid / rows[i]!.mid) / (Math.max(rows[i]!.sigma, 1e-8) * Math.sqrt(H)) / 2);
    }
  }
  const nTrain = Math.floor(rows.length * o.trainFrac);
  const testStart = Math.min(rows.length, nTrain + H); // purge
  const d = rows.length ? rows[0]!.x.length : Math.min(brain.readoutDim, g.readoutGroups);
  const empty = (): EvalResult => ({
    id: g.id, parent: g.parent, fitness: -1e9, valid: false, netReturnPct: 0, buyHoldPct: 0, winRate: 0, trades: 0, maxDrawdownPct: 0, exposure: 0, avgHoldSec: 0,
    icTrain: 0, icTest: 0, rows: rows.length, testRows: Math.max(0, rows.length - testStart), msPerSample, readout: { dim: d, b: 0, w: [] }, yScale: 1,
  });
  if (nTrain < d / 2 || rows.length - testStart < 60) return empty();

  const acc = new RidgeAccumulator(d);
  for (let i = 0; i < nTrain; i++) if (!Number.isNaN(ys[i]!)) acc.add(rows[i]!.x, ys[i]!);
  if (acc.rows < 10) return empty();
  const readout = acc.solve(g.lambda);
  const yhat = rows.map((r) => predict(readout, r.x));
  const trainIdx = [...Array(nTrain).keys()].filter((i) => !Number.isNaN(ys[i]!));
  const testIdx: number[] = [];
  for (let i = testStart; i < rows.length; i++) if (!Number.isNaN(ys[i]!)) testIdx.push(i);
  const icTrain = correlation(trainIdx.map((i) => yhat[i]!), trainIdx.map((i) => ys[i]!));
  const icTest = correlation(testIdx.map((i) => yhat[i]!), testIdx.map((i) => ys[i]!));
  let m = 0;
  for (const i of trainIdx) m += yhat[i]!;
  m /= Math.max(1, trainIdx.length);
  let v = 0;
  for (const i of trainIdx) v += (yhat[i]! - m) ** 2;
  const sd = Math.sqrt(v / Math.max(1, trainIdx.length)) || 1e-9;

  // 정책 시뮬 (테스트 구간, 1초 걸음)
  const fee = o.takerFeeBps / 1e4;
  const thetaIn = g.policy.thetaIn * sd;
  const thetaOut = g.policy.thetaOut * sd;
  let cash = 1;
  let qty = 0;
  let entryEquity = 0;
  let entryT = 0;
  let trades = 0;
  let wins = 0;
  let holdSum = 0;
  let peak = 1;
  let mdd = 0;
  let longSamples = 0;
  let curSeg = rows[testStart]?.seg ?? 0;
  const first = rows[testStart];
  const last = rows[rows.length - 1];
  const sellAll = (r: Row): void => {
    const proceeds = qty * r.bid * (1 - fee);
    cash += proceeds;
    qty = 0;
    trades++;
    if (cash > entryEquity) wins++;
    holdSum += (r.t - entryT) / 1000;
  };
  for (let i = testStart; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.seg !== curSeg) {
      if (qty > 0) sellAll(rows[i - 1]!);
      curSeg = r.seg;
    }
    const y = yhat[i]!;
    const equity = cash + qty * r.bid;
    if (qty > 0) {
      longSamples++;
      if (y < thetaOut && (r.t - entryT) / 1000 >= g.policy.minHoldSec) sellAll(r);
    } else if (y > thetaIn) {
      const spend = cash * g.policy.maxFrac;
      qty = (spend * (1 - fee)) / r.ask;
      cash -= spend;
      entryEquity = equity;
      entryT = r.t;
    }
    const eq = cash + qty * r.bid;
    if (eq > peak) peak = eq;
    mdd = Math.max(mdd, (peak - eq) / peak);
  }
  if (qty > 0) sellAll(last!);
  const netReturnPct = (cash - 1) * 100;
  const buyHoldPct = first && last ? (last.mid / first.mid - 1) * 100 : 0;
  const winRate = trades ? wins / trades : 0;
  const valid = trades >= o.minTrades;
  // 적합도: 순수익(%) + 승률 보너스 (50% 초과분 1%p당 0.02). 거래가 너무 적으면 무효.
  const fitness = valid ? netReturnPct + (winRate - 0.5) * 2 : -1e9 + trades;

  // 배치용 재적합 (전 구간, 같은 λ)
  for (let i = nTrain; i < rows.length; i++) if (!Number.isNaN(ys[i]!)) acc.add(rows[i]!.x, ys[i]!);
  const full = acc.solve(g.lambda);
  const yhatFull = rows.map((r) => predict(full, r.x));
  const mf = yhatFull.reduce((a, b) => a + b, 0) / yhatFull.length;
  const sdFull = Math.sqrt(yhatFull.reduce((a, b) => a + (b - mf) ** 2, 0) / yhatFull.length) || 1e-9;

  return {
    id: g.id, parent: g.parent, fitness, valid, netReturnPct, buyHoldPct, winRate, trades,
    maxDrawdownPct: mdd * 100, exposure: longSamples / Math.max(1, rows.length - testStart), avgHoldSec: trades ? holdSum / trades : 0,
    icTrain, icTest, rows: rows.length, testRows: rows.length - testStart, msPerSample,
    readout: { dim: d, b: full.b, w: Array.from(full.w) }, yScale: sdFull,
  };
}

export type { Readout };
