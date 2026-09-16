/**
 * 하강뉴런 활동 → 예측의 선형 판독 (ridge 회귀). 뇌(reservoir)는 고정, 학습되는 것은 이 벡터 하나다.
 * 정규방정식을 온라인으로 누적하고(XᵀX, Xᵀy) Cholesky로 푼다. λ는 XᵀX 대각 평균에 상대적.
 */
export interface Readout {
  dim: number;
  w: Float32Array;
  b: number;
}

export class RidgeAccumulator {
  private readonly xtx: Float64Array;
  private readonly xty: Float64Array;
  private readonly xsum: Float64Array;
  private ysum = 0;
  private n = 0;

  constructor(readonly dim: number) {
    this.xtx = new Float64Array(dim * dim);
    this.xty = new Float64Array(dim);
    this.xsum = new Float64Array(dim);
  }

  get rows(): number {
    return this.n;
  }

  add(x: Float32Array, y: number): void {
    const d = this.dim;
    const { xtx, xty, xsum } = this;
    for (let i = 0; i < d; i++) {
      const xi = x[i]!;
      if (xi === 0) continue;
      xsum[i] = xsum[i]! + xi;
      xty[i] = xty[i]! + xi * y;
      const row = i * d;
      for (let j = i; j < d; j++) xtx[row + j] = xtx[row + j]! + xi * x[j]!; // upper triangle
    }
    this.ysum += y;
    this.n++;
  }

  /** 중심화된 ridge: (Xcᵀ Xc + λ·tr/d · I) w = Xcᵀ yc, b = ȳ − μ·w. */
  solve(lambda: number): Readout {
    const d = this.dim;
    const n = this.n;
    if (n < 2) throw new Error('ridge: not enough rows');
    const mu = new Float64Array(d);
    for (let i = 0; i < d; i++) mu[i] = this.xsum[i]! / n;
    const ybar = this.ysum / n;
    const a = new Float64Array(d * d);
    let trace = 0;
    for (let i = 0; i < d; i++) {
      for (let j = i; j < d; j++) {
        const v = this.xtx[i * d + j]! - n * mu[i]! * mu[j]!;
        a[i * d + j] = v;
        a[j * d + i] = v;
      }
      trace += a[i * d + i]!;
    }
    const ridge = (lambda * trace) / d + 1e-12;
    for (let i = 0; i < d; i++) a[i * d + i] = a[i * d + i]! + ridge;
    const rhs = new Float64Array(d);
    for (let i = 0; i < d; i++) rhs[i] = this.xty[i]! - n * mu[i]! * ybar;
    const w = choleskySolve(a, rhs, d);
    let b = ybar;
    for (let i = 0; i < d; i++) b -= mu[i]! * w[i]!;
    return { dim: d, w: Float32Array.from(w), b };
  }
}

/** A (SPD, d×d row-major) x = rhs. A는 제자리에서 L로 덮어써진다. */
function choleskySolve(a: Float64Array, rhs: Float64Array, d: number): Float64Array {
  for (let j = 0; j < d; j++) {
    let s = a[j * d + j]!;
    for (let k = 0; k < j; k++) s -= a[j * d + k]! ** 2;
    if (s <= 0) throw new Error(`ridge: matrix not positive definite at ${j}`);
    const ljj = Math.sqrt(s);
    a[j * d + j] = ljj;
    for (let i = j + 1; i < d; i++) {
      let t = a[i * d + j]!;
      const ri = i * d;
      const rj = j * d;
      for (let k = 0; k < j; k++) t -= a[ri + k]! * a[rj + k]!;
      a[ri + j] = t / ljj;
    }
  }
  const y = new Float64Array(d);
  for (let i = 0; i < d; i++) {
    let t = rhs[i]!;
    for (let k = 0; k < i; k++) t -= a[i * d + k]! * y[k]!;
    y[i] = t / a[i * d + i]!;
  }
  const x = new Float64Array(d);
  for (let i = d - 1; i >= 0; i--) {
    let t = y[i]!;
    for (let k = i + 1; k < d; k++) t -= a[k * d + i]! * x[k]!;
    x[i] = t / a[i * d + i]!;
  }
  return x;
}

/**
 * 하강뉴런 1,305개를 인접 그룹 평균으로 묶어 판독 차원을 줄인다 (과적합 억제: 기록 30분 ≈ 1,000행에 1,305차원은 무의미).
 * groups ≥ n이면 그대로.
 */
export function pool(x: Float32Array, groups: number): Float32Array {
  const n = x.length;
  if (groups >= n) return Float32Array.from(x);
  const size = Math.ceil(n / groups);
  const out = new Float32Array(Math.ceil(n / size));
  for (let k = 0; k < out.length; k++) {
    const a = k * size;
    const b = Math.min(n, a + size);
    let s = 0;
    for (let i = a; i < b; i++) s += x[i]!;
    out[k] = s / (b - a);
  }
  return out;
}

export function predict(r: Readout, x: Float32Array): number {
  let s = r.b;
  for (let i = 0; i < r.dim; i++) s += r.w[i]! * x[i]!;
  return s;
}

/** 피어슨 상관 (IC). */
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}
