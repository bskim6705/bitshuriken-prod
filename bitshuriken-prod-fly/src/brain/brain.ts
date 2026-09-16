import type { Connectome } from './connectome';
import type { FeatureSpec } from './features';
import { READOUT_POPULATION, SENSORY_INPUT, type Population } from './populations';

/**
 * 뇌 동역학 파라미터. 시냅스 부호·위상은 커넥톰 그대로, 크기는 뉴런별 Lp 정규화 × gain.
 * 기본값(p=1.5, gain 0.9, 입력 ×3)은 실측 선택: p=1은 깊은 층 활동이 소멸(하강뉴런 12%만 살아있음),
 * p=2는 허브 폭주로 초기 상태에 따라 다른 끌개에 갇힌다. p=1.5는 하강뉴런 73%가 살아 있으면서
 * 서로 다른 초기 상태가 같은 입력 이력 아래 float32 정밀도까지 수렴한다(echo state) — 라이브 warmup
 * 후의 뇌 상태가 학습 때와 같다는 뜻. train이 매 학습마다 이 수렴을 재측정한다(echoDiff).
 */
export interface BrainParams {
  normP: number; // 시냅스 크기 Lp 정규화 지수 (1 = Σ|w|=1, 2 = Σw²=1; connectome.normalizedWeights)
  gain: number; // 시냅스 총입력 스케일
  leak: number; // 서브스텝당 상태 교체 비율 α: h ← (1−α)h + α·tanh(pre)
  substeps: number; // bar당 전파 스텝 (감각→투사→중앙→하강 다중 홉)
  inputGain: number; // 감각 뉴런 주입 세기
  inputDensity: number; // 감각 뉴런 하나가 받는 채널 비율
  seed: number; // 입력 투사 난수 시드
  /** 감각 집단별 입력 배율 (진화 유전자). 없으면 1. */
  modalityGain?: Partial<Record<Population, number>>;
}
export const DEFAULT_BRAIN: BrainParams = { normP: 1.5, gain: 0.9, leak: 0.3, substeps: 4, inputGain: 3.0, inputDensity: 0.5, seed: 7 };

export interface PopulationActivity {
  name: Population;
  n: number;
  mean: number; // mean |h|
  active: number; // fraction |h| > 0.2
}

/** mulberry32 — 시드 고정 난수 (입력 투사 재현). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 커넥톰 위의 leaky-tanh rate 네트워크. 시장 피처(specs가 정의)는 감각 뉴런으로, 판독은 하강뉴런에서. */
export class FlyBrain {
  readonly N: number;
  readonly nFeatures: number;
  private readonly nChannels: number;
  readonly h: Float32Array; // 뉴런 활동
  private readonly pre: Float32Array;
  private readonly w: Float32Array; // 정규화 가중치 (CSR, post-major)
  private readonly rowPtr: Int32Array;
  private readonly colIdx: Int32Array;
  private readonly inputIdx: Int32Array; // 입력 받는 감각 뉴런
  private readonly inputW: Float32Array; // [nIn × nChannels]
  private readonly current: Float32Array; // 감각 뉴런별 주입 전류 (bar 동안 고정)
  private readonly channels: Float32Array;
  private readonly dn: { start: number; end: number };

  constructor(
    readonly conn: Connectome,
    readonly params: BrainParams,
    readonly specs: readonly FeatureSpec[],
  ) {
    this.N = conn.N;
    this.nFeatures = specs.length;
    this.nChannels = 2 * specs.length;
    this.channels = new Float32Array(this.nChannels);
    this.h = new Float32Array(this.N);
    this.pre = new Float32Array(this.N);
    this.w = conn.normalizedWeights(params.normP);
    this.rowPtr = conn.rowPtr;
    this.colIdx = conn.colIdx;
    this.dn = conn.range(READOUT_POPULATION);

    // 감각 모달리티별 입력 투사: 채널(피처 ON/OFF)이 향하는 집단의 뉴런들에 희소 난수 가중치
    const rand = rng(params.seed);
    const idx: number[] = [];
    const weights: number[] = [];
    for (const pop of SENSORY_INPUT) {
      const r = conn.range(pop);
      const mg = params.modalityGain?.[pop] ?? 1;
      for (let n = r.start; n < r.end; n++) {
        const row = new Array<number>(this.nChannels).fill(0);
        let any = false;
        for (let f = 0; f < this.nFeatures; f++) {
          const spec = specs[f]!;
          if (spec.on === pop && rand() < params.inputDensity) {
            row[2 * f] = params.inputGain * mg * (0.5 + rand());
            any = true;
          }
          if (spec.off === pop && rand() < params.inputDensity) {
            row[2 * f + 1] = params.inputGain * mg * (0.5 + rand());
            any = true;
          }
        }
        if (!any) continue;
        idx.push(n);
        weights.push(...row);
      }
    }
    this.inputIdx = Int32Array.from(idx);
    this.inputW = Float32Array.from(weights);
    this.current = new Float32Array(idx.length);
  }

  get inputNeurons(): number {
    return this.inputIdx.length;
  }

  reset(): void {
    this.h.fill(0);
  }

  /** bar 하나의 피처를 감각 뉴런에 걸고 substeps만큼 전파한다. */
  step(features: Float32Array): void {
    const { gain, leak, substeps } = this.params;
    const ch = this.channels;
    const nF = this.nFeatures;
    const nC = this.nChannels;
    for (let f = 0; f < nF; f++) {
      const x = features[f]!;
      ch[2 * f] = x > 0 ? x : 0;
      ch[2 * f + 1] = x < 0 ? -x : 0;
    }
    const nIn = this.inputIdx.length;
    for (let j = 0; j < nIn; j++) {
      let acc = 0;
      const base = j * nC;
      for (let c = 0; c < nC; c++) acc += this.inputW[base + c]! * ch[c]!;
      this.current[j] = acc;
    }
    const { h, pre, w, rowPtr, colIdx, inputIdx, current, N } = this;
    for (let s = 0; s < substeps; s++) {
      for (let i = 0; i < N; i++) {
        let acc = 0;
        const b = rowPtr[i + 1]!;
        for (let e = rowPtr[i]!; e < b; e++) acc += w[e]! * h[colIdx[e]!]!;
        pre[i] = gain * acc;
      }
      for (let j = 0; j < nIn; j++) pre[inputIdx[j]!] = pre[inputIdx[j]!]! + current[j]!;
      for (let i = 0; i < N; i++) h[i] = h[i]! + leak * (Math.tanh(pre[i]!) - h[i]!);
    }
  }

  /** 하강뉴런 활동 (뷰 — 보관하려면 복사). */
  descending(): Float32Array {
    return this.h.subarray(this.dn.start, this.dn.end);
  }

  get readoutDim(): number {
    return this.dn.end - this.dn.start;
  }

  /** 집단별 활동 요약 (대시보드). */
  activity(): PopulationActivity[] {
    return this.conn.meta.populations
      .filter((p) => p.end > p.start)
      .map((p) => {
        let sum = 0;
        let act = 0;
        for (let i = p.start; i < p.end; i++) {
          const a = Math.abs(this.h[i]!);
          sum += a;
          if (a > 0.2) act++;
        }
        const n = p.end - p.start;
        return { name: p.name, n, mean: sum / n, active: act / n };
      });
  }
}
