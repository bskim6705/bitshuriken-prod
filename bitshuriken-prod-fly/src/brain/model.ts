import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainParams } from './brain';
import type { InputKind } from './inputs';

/** 학습 산출물 — 커넥톰 식별 + 뇌 파라미터(입력 투사 시드 포함) + 하강뉴런 판독 벡터. JSON 한 파일. */
export interface FlyModel {
  version: 1;
  kind: 'flybrain';
  symbol: string;
  /** 'bars': interval = 봉 길이(1m…). 'lob': 1초 샘플, interval = '1s'. */
  inputKind: InputKind;
  interval: string;
  /** 예측 지평 (bar 또는 초). 타깃 = tanh(log(p[t+H]/p[t]) / (σ√H) / 2). */
  horizon: number;
  connectome: { region: 'central' | 'full'; N: number; E: number; builtAt: string };
  brain: BrainParams;
  features: string[];
  readout: { dim: number; b: number; w: number[] };
  /** 하강뉴런 풀링 그룹 수 (readout.pool). 없으면 풀링 없음(v1). */
  readoutGroups?: number;
  /** 이 예측값 이상이면 풀 노출 (학습 구간 양의 예측 80분위). lob 모델에선 ŷ 표준편차. */
  yScale: number;
  /** lob 모델의 임계 정책 (진화 유전자): ŷ > thetaIn·yScale 진입, ŷ < thetaOut·yScale 청산. */
  lobPolicy?: { thetaIn: number; thetaOut: number; minHoldSec: number; maxFrac: number };
  /** 진화 출처 (lob 모델). */
  evo?: { generation: number; fitness: number; netReturnPct: number; winRate: number; trades: number; icTest: number; recordingRows: number };
  trainedAt: string;
  train: {
    from: number;
    to: number;
    bars: number;
    rows: number;
    lambda: number;
    val: ValidationReport;
    inSampleIc: number;
    msPerBar: number;
    /** echo-state 자가 점검: 다른 초기 상태의 뇌가 settle 구간 뒤 하강뉴런에서 벌어진 최대 차이. */
    echoDiff: number;
  };
}

export interface LambdaScore {
  lambda: number;
  ic: number;
  hitRate: number;
  topQuintileMeanY: number;
}

export interface ValidationReport {
  rows: number;
  meanY: number;
  best: LambdaScore;
  grid: LambdaScore[];
}

export function saveModel(path: string, model: FlyModel): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(model));
}

export function loadModel(path: string): FlyModel {
  if (!existsSync(path)) throw new Error(`flybrain model not found: ${path}`);
  const m = JSON.parse(readFileSync(path, 'utf8')) as FlyModel;
  if (m.kind !== 'flybrain' || m.version !== 1) throw new Error(`${path}: not a flybrain v1 model`);
  return m;
}

const INTERVALS: Record<number, string> = {
  60_000: '1m',
  180_000: '3m',
  300_000: '5m',
  900_000: '15m',
  1_800_000: '30m',
  3_600_000: '1h',
  14_400_000: '4h',
  86_400_000: '1d',
};

/** bar의 open→close 길이로 interval 라벨 추정 (모델 파일 선택용). */
export function intervalOfBar(openTime: number, closeTime: number): string {
  const ms = Math.round((closeTime - openTime) / 60_000) * 60_000;
  const label = INTERVALS[ms];
  if (!label) throw new Error(`flybrain: unsupported bar length ${closeTime - openTime}ms`);
  return label;
}
