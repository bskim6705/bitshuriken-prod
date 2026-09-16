import { DEFAULT_BRAIN, type BrainParams } from '../brain/brain';
import { SENSORY_INPUT, type SensoryPopulation } from '../brain/populations';

/** 파리 한 마리의 유전자. 뇌 유전자는 하강뉴런 궤적을 바꾸고(비쌈), 판독·정책 유전자는 그 위에서 싸게 평가된다. */
export interface Genome {
  id: string;
  parent: string | null;
  brain: BrainParams;
  horizonSec: number; // 예측 지평 (초)
  lambda: number; // ridge
  readoutGroups: number; // 하강뉴런 풀링 그룹 수 (판독 차원)
  policy: { thetaIn: number; thetaOut: number; minHoldSec: number; maxFrac: number }; // θ는 ŷ 표준편차 배수
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 표준정규 (Box–Muller). */
const gauss = (r: () => number): number => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
const clip = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export function baseGenome(id: string): Genome {
  const modalityGain: Partial<Record<SensoryPopulation, number>> = {};
  for (const p of SENSORY_INPUT) modalityGain[p] = 1;
  return {
    id,
    parent: null,
    brain: { ...DEFAULT_BRAIN, modalityGain },
    horizonSec: 20,
    lambda: 0.1,
    readoutGroups: 128,
    policy: { thetaIn: 1.0, thetaOut: -0.5, minHoldSec: 10, maxFrac: 0.5 },
  };
}

/** 돌연변이: 연속 유전자는 로그 정규 교란, 정수는 ±1, 시드는 가끔 새로. `strength` 1 = 표준. */
export function mutate(g: Genome, id: string, r: () => number, strength = 1): Genome {
  const logn = (x: number, sd: number): number => x * Math.exp(gauss(r) * sd * strength);
  const maybe = (p: number): boolean => r() < p;
  const b = { ...g.brain, modalityGain: { ...g.brain.modalityGain } };
  if (maybe(0.5)) b.gain = clip(logn(b.gain, 0.1), 0.3, 1.3);
  if (maybe(0.4)) b.leak = clip(logn(b.leak, 0.2), 0.05, 0.9);
  if (maybe(0.3)) b.inputGain = clip(logn(b.inputGain, 0.25), 0.3, 10);
  if (maybe(0.3)) b.inputDensity = clip(logn(b.inputDensity, 0.2), 0.1, 1);
  if (maybe(0.3)) b.normP = clip(b.normP + gauss(r) * 0.1 * strength, 1, 2);
  if (maybe(0.2)) b.substeps = clip(Math.round(b.substeps + (r() < 0.5 ? -1 : 1)), 2, 6);
  if (maybe(0.15)) b.seed = Math.floor(r() * 1e9);
  for (const p of SENSORY_INPUT) if (maybe(0.25)) b.modalityGain![p] = clip(logn(b.modalityGain![p] ?? 1, 0.4), 0.05, 5);
  const policy = { ...g.policy };
  if (maybe(0.5)) policy.thetaIn = clip(policy.thetaIn + gauss(r) * 0.3 * strength, 0.2, 3);
  if (maybe(0.5)) policy.thetaOut = clip(policy.thetaOut + gauss(r) * 0.3 * strength, -3, policy.thetaIn - 0.1);
  if (maybe(0.4)) policy.minHoldSec = clip(Math.round(logn(policy.minHoldSec, 0.5)), 1, 600);
  if (maybe(0.3)) policy.maxFrac = clip(policy.maxFrac + gauss(r) * 0.1 * strength, 0.1, 1);
  return {
    id,
    parent: g.id,
    brain: b,
    horizonSec: maybe(0.5) ? clip(Math.round(logn(g.horizonSec, 0.4)), 3, 300) : g.horizonSec,
    lambda: maybe(0.5) ? clip(g.lambda * 10 ** (gauss(r) * 0.5 * strength), 1e-5, 100) : g.lambda,
    readoutGroups: maybe(0.3) ? clip(Math.round(logn(g.readoutGroups, 0.4)), 32, 1305) : g.readoutGroups,
    policy,
  };
}
