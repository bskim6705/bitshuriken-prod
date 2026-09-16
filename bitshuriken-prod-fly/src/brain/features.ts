import type { Bar } from '../core/types';
import type { SensoryPopulation } from './populations';

/**
 * bar 하나 → 유계 피처 벡터. OHLCV만 쓰므로 라이브·백테스트가 동일하다. 각 피처는 ON(+)/OFF(−) 두
 * 채널로 정류돼 감각 뉴런에 들어간다 (발화율은 음수가 없다). 수익률은 냄새 — 오르면 먹이(ORN),
 * 내리면 위험(페로몬 ORN); 거래량·변동폭은 소리(존스턴 기관); 변동성 국면은 온도; 평균회귀 위치는 맛/촉각.
 */
export interface FeatureSpec {
  name: string;
  on: SensoryPopulation;
  off: SensoryPopulation;
}

const ret = (name: string): FeatureSpec => ({ name, on: 'ORN', off: 'ORN_PHEROMONE' });
/** v1 입력 — 1분봉 OHLCV 지표 (feedback-032 이후 레거시; 실시간 입력은 lob/features.ts). */
export const BAR_FEATURES: readonly FeatureSpec[] = [
  ret('r1'),
  ret('r3'),
  ret('r6'),
  ret('r12'),
  ret('r24'),
  ret('r48'),
  { name: 'volZ', on: 'MECH_JO', off: 'MECH_JO' },
  { name: 'rangeZ', on: 'MECH_JO', off: 'MECH_JO' },
  { name: 'volRegime', on: 'THERMO_HYGRO', off: 'THERMO_HYGRO' },
  { name: 'posInRange', on: 'GRN', off: 'GRN' },
  { name: 'emaDist20', on: 'MECH_BRISTLE', off: 'MECH_BRISTLE' },
  { name: 'emaDist100', on: 'MECH_BRISTLE', off: 'MECH_BRISTLE' },
];
export const FEATURES = BAR_FEATURES;
export const N_FEATURES = BAR_FEATURES.length;
/** 피처 통계(EWMA·EMA)가 안정되기까지의 bar 수. 그 전엔 update()가 null. */
export const FEATURE_WARMUP = 100;

const RET_HORIZONS = [1, 3, 6, 12, 24, 48];
const HISTORY = 64; // ≥ max horizon + range window
const RANGE_WINDOW = 12;
const alpha = (span: number): number => 2 / (span + 1);
const A_LONG = alpha(100);
const A_SHORT = alpha(12);
const A_EMA20 = alpha(20);
const A_EMA100 = alpha(100);
const squash = (x: number): number => Math.tanh(x / 2);

export class BarFeatures {
  private closes: number[] = [];
  private highs: number[] = [];
  private lows: number[] = [];
  private count = 0;
  private varLong = 0;
  private varShort = 0;
  private logVolMean = 0;
  private logVolVar = 0;
  private rangeMean = 0;
  private ema20 = 0;
  private ema100 = 0;

  /** 현재 1-bar 로그수익률 변동성 (σ). 타깃 정규화에 쓴다. */
  get vol(): number {
    return Math.sqrt(Math.max(this.varLong, 1e-12));
  }

  get warm(): boolean {
    return this.count >= FEATURE_WARMUP;
  }

  update(bar: Bar): Float32Array | null {
    const c = bar.close;
    const prev = this.closes.length ? this.closes[this.closes.length - 1]! : c;
    const lr = Math.log(c / prev);
    const logVol = Math.log(bar.volume + 1);
    const range = c > 0 ? (bar.high - bar.low) / c : 0;
    if (this.count === 0) {
      this.varLong = this.varShort = 1e-8;
      this.logVolMean = logVol;
      this.logVolVar = 1;
      this.rangeMean = range || 1e-6;
      this.ema20 = this.ema100 = c;
    } else {
      this.varLong += A_LONG * (lr * lr - this.varLong);
      this.varShort += A_SHORT * (lr * lr - this.varShort);
      this.logVolMean += A_LONG * (logVol - this.logVolMean);
      this.logVolVar += A_LONG * ((logVol - this.logVolMean) ** 2 - this.logVolVar);
      this.rangeMean += A_LONG * (range - this.rangeMean);
      this.ema20 += A_EMA20 * (c - this.ema20);
      this.ema100 += A_EMA100 * (c - this.ema100);
    }
    this.closes.push(c);
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    if (this.closes.length > HISTORY) {
      this.closes.shift();
      this.highs.shift();
      this.lows.shift();
    }
    this.count++;
    if (!this.warm) return null;

    const sigma = this.vol;
    const out = new Float32Array(N_FEATURES);
    let k = 0;
    const n = this.closes.length;
    for (const h of RET_HORIZONS) {
      const back = this.closes[Math.max(0, n - 1 - h)]!;
      out[k++] = squash(Math.log(c / back) / (sigma * Math.sqrt(h)));
    }
    out[k++] = squash((logVol - this.logVolMean) / Math.sqrt(Math.max(this.logVolVar, 1e-8)));
    out[k++] = squash(Math.log(Math.max(range, 1e-9) / Math.max(this.rangeMean, 1e-9)));
    out[k++] = squash(0.5 * Math.log(Math.max(this.varShort, 1e-12) / Math.max(this.varLong, 1e-12)));
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = Math.max(0, n - RANGE_WINDOW); i < n; i++) {
      hi = Math.max(hi, this.highs[i]!);
      lo = Math.min(lo, this.lows[i]!);
    }
    out[k++] = hi > lo ? 2 * ((c - lo) / (hi - lo)) - 1 : 0;
    out[k++] = squash((c / this.ema20 - 1) / (sigma * Math.sqrt(20)));
    out[k++] = squash((c / this.ema100 - 1) / (sigma * Math.sqrt(100)));
    return out;
  }
}
