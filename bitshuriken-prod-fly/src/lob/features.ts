import type { FeatureSpec } from '../brain/features';
import { type LobSample, mid as midOf } from './sample';

/**
 * 실시간 호가창 피처 (오더북 트레이딩 연구의 표준 신호들). 1초 샘플마다 27개, 전부 유계.
 * 감각 배정: 불균형·체결 흐름·OFI = 미각(달다 = 매수 압력 / 쓰다 = 매도 압력), 가격 움직임 = 후각(오르면 먹이,
 * 내리면 페로몬), 북 형태·스프레드 = 촉각(강모), 활동량 = 청각(존스턴 기관), 변동성 국면·정적 = 온도.
 */
const taste = (name: string): FeatureSpec => ({ name, on: 'GRN', off: 'GRN' });
const smell = (name: string): FeatureSpec => ({ name, on: 'ORN', off: 'ORN_PHEROMONE' });
const touch = (name: string): FeatureSpec => ({ name, on: 'MECH_BRISTLE', off: 'MECH_BRISTLE' });
const hear = (name: string): FeatureSpec => ({ name, on: 'MECH_JO', off: 'MECH_JO' });
const temp = (name: string): FeatureSpec => ({ name, on: 'THERMO_HYGRO', off: 'THERMO_HYGRO' });

export const LOB_FEATURES: readonly FeatureSpec[] = [
  taste('imb1'), // 최우선 호가 수량 불균형 (b−a)/(b+a)
  taste('imb5'), // 상위 5레벨 누적 불균형
  taste('imb10'),
  taste('imb20'),
  taste('micro'), // (microprice − mid)/mid, bps
  taste('flow1s'), // 직전 1초 서명 체결량 비율
  taste('flow5s'), // 서명 체결량 EWMA 5s (z)
  taste('flow30s'), // 서명 체결량 EWMA 30s (z)
  taste('ofi1s'), // order flow imbalance (Cont) 직전 1초
  taste('ofi5s'), // OFI EWMA 5s
  smell('r1s'), // mid 로그수익률 / σ, 지평 1s
  smell('r5s'),
  smell('r30s'),
  smell('r2m'),
  smell('r10m'),
  smell('emaDist60s'), // mid vs EMA(60s) 거리 / σ√60
  touch('spread'), // 스프레드 bps
  touch('depthLog'), // log(Σbid20 / Σask20)
  touch('bidSlope'), // (bid1 − bid20)/mid bps — 매수벽 두께(가격 폭)
  touch('askSlope'),
  touch('bidDepthZ'), // Σbid20 (log) z
  touch('askDepthZ'),
  hear('intensity'), // 체결 건수 z
  hear('depthRate'), // depth 갱신 수 z
  hear('tradeVolZ'), // 체결 수량(log) z
  temp('volRegime'), // log(σ10s / σ5m)
  temp('sinceTrade'), // 마지막 체결 후 경과 시간(log s)
];
export const N_LOB_FEATURES = LOB_FEATURES.length;
/** 장기 EWMA(5분)가 자리잡기까지의 샘플 수. 그 전엔 update()가 null. */
export const LOB_FEATURE_WARMUP = 120;

const alpha = (spanS: number): number => 2 / (spanS + 1);
const A_LONG = alpha(300);
const A_SHORT = alpha(10);
const A_5S = alpha(5);
const A_30S = alpha(30);
const A_60S = alpha(60);
const HIST = 601;
const squash = (x: number): number => Math.tanh(x / 2);
const sum = (levels: [number, number][], n: number): number => {
  let s = 0;
  for (let i = 0; i < Math.min(n, levels.length); i++) s += levels[i]![1];
  return s;
};
const imbalance = (s: LobSample, n: number): number => {
  const b = sum(s.bids, n);
  const a = sum(s.asks, n);
  return b + a > 0 ? (b - a) / (b + a) : 0;
};

/** EWMA 평균/분산으로 z 점수. */
class Zscore {
  private mean = NaN;
  private variance = 1;
  constructor(private readonly a: number) {}
  update(x: number): number {
    if (Number.isNaN(this.mean)) {
      this.mean = x;
      this.variance = Math.max(x * x * 0.1, 1e-6);
      return 0;
    }
    this.mean += this.a * (x - this.mean);
    this.variance += this.a * ((x - this.mean) ** 2 - this.variance);
    return (x - this.mean) / Math.sqrt(Math.max(this.variance, 1e-12));
  }
}

export class LobFeatures {
  private count = 0;
  private mids: number[] = [];
  private varLong = 1e-10;
  private varShort = 1e-10;
  private ema60 = NaN;
  private flow5 = 0;
  private flow30 = 0;
  private flowAbs = NaN; // 서명 흐름 정규화용 |flow| EWMA
  private ofi5 = 0;
  private bestQtyAvg = NaN;
  private prevBid: [number, number] | null = null;
  private prevAsk: [number, number] | null = null;
  private lastTradeTs = 0;
  private readonly zVol = new Zscore(A_LONG);
  private readonly zCount = new Zscore(A_LONG);
  private readonly zDepthMsgs = new Zscore(A_LONG);
  private readonly zBidDepth = new Zscore(A_LONG);
  private readonly zAskDepth = new Zscore(A_LONG);
  lastMid = NaN;

  /** 1초 mid 로그수익률의 변동성 σ (초 단위). 타깃 정규화에 쓴다. */
  get vol(): number {
    return Math.sqrt(Math.max(this.varLong, 1e-14));
  }

  get warm(): boolean {
    return this.count >= LOB_FEATURE_WARMUP;
  }

  update(s: LobSample): Float32Array | null {
    if (!s.bids.length || !s.asks.length) return null;
    const m = midOf(s);
    const [b1, bq1] = s.bids[0]!;
    const [a1, aq1] = s.asks[0]!;
    const prevMid = this.mids.length ? this.mids[this.mids.length - 1]! : m;
    const lr = Math.log(m / prevMid);
    if (this.count === 0) {
      this.ema60 = m;
      this.varLong = this.varShort = 1e-10;
    } else {
      this.varLong += A_LONG * (lr * lr - this.varLong);
      this.varShort += A_SHORT * (lr * lr - this.varShort);
      this.ema60 += A_60S * (m - this.ema60);
    }
    this.mids.push(m);
    if (this.mids.length > HIST) this.mids.shift();

    // 체결 흐름
    let buy = 0;
    let sell = 0;
    let vol = 0;
    for (const [ts, , qty, side] of s.trades) {
      if (side > 0) buy += qty;
      else sell += qty;
      vol += qty;
      this.lastTradeTs = Math.max(this.lastTradeTs, ts);
    }
    const signed = buy - sell;
    this.flowAbs = Number.isNaN(this.flowAbs) ? Math.max(Math.abs(signed), 1e-6) : this.flowAbs + A_LONG * (Math.abs(signed) - this.flowAbs);
    this.flow5 += A_5S * (signed - this.flow5);
    this.flow30 += A_30S * (signed - this.flow30);
    const flowScale = Math.max(this.flowAbs, 1e-6);

    // OFI (Cont–Kukanov–Stoikov): 최우선 호가의 가격·수량 변화에서 순 주문 흐름
    let ofi = 0;
    if (this.prevBid && this.prevAsk) {
      const [pb, pbq] = this.prevBid;
      const [pa, paq] = this.prevAsk;
      ofi = (b1 >= pb ? bq1 : 0) - (b1 <= pb ? pbq : 0) - (a1 <= pa ? aq1 : 0) + (a1 >= pa ? paq : 0);
    }
    this.prevBid = [b1, bq1];
    this.prevAsk = [a1, aq1];
    const bestQty = (bq1 + aq1) / 2;
    this.bestQtyAvg = Number.isNaN(this.bestQtyAvg) ? Math.max(bestQty, 1e-6) : this.bestQtyAvg + A_LONG * (bestQty - this.bestQtyAvg);
    const ofiN = ofi / Math.max(this.bestQtyAvg, 1e-6);
    this.ofi5 += A_5S * (ofiN - this.ofi5);

    // 북 형태
    const bidDepth = sum(s.bids, 20);
    const askDepth = sum(s.asks, 20);
    const bidFar = s.bids[Math.min(19, s.bids.length - 1)]![0];
    const askFar = s.asks[Math.min(19, s.asks.length - 1)]![0];
    const micro = (b1 * aq1 + a1 * bq1) / (bq1 + aq1);

    this.count++;
    this.lastMid = m;
    const zVol = this.zVol.update(Math.log(vol + 1e-6));
    const zCount = this.zCount.update(s.trades.length);
    const zDepthMsgs = this.zDepthMsgs.update(s.depthMsgs);
    const zBid = this.zBidDepth.update(Math.log(bidDepth + 1e-9));
    const zAsk = this.zAskDepth.update(Math.log(askDepth + 1e-9));
    if (!this.warm) return null;

    const sigma = this.vol;
    const n = this.mids.length;
    const ret = (k: number): number => squash(Math.log(m / this.mids[Math.max(0, n - 1 - k)]!) / (sigma * Math.sqrt(k)));
    const out = new Float32Array(N_LOB_FEATURES);
    let i = 0;
    out[i++] = imbalance(s, 1);
    out[i++] = imbalance(s, 5);
    out[i++] = imbalance(s, 10);
    out[i++] = imbalance(s, 20);
    out[i++] = squash(((micro - m) / m) * 1e4);
    out[i++] = vol > 0 ? signed / vol : 0;
    out[i++] = squash(this.flow5 / flowScale);
    out[i++] = squash(this.flow30 / flowScale);
    out[i++] = squash(ofiN);
    out[i++] = squash(this.ofi5);
    out[i++] = ret(1);
    out[i++] = ret(5);
    out[i++] = ret(30);
    out[i++] = ret(120);
    out[i++] = ret(600);
    out[i++] = squash((m / this.ema60 - 1) / (sigma * Math.sqrt(60)));
    out[i++] = squash(((a1 - b1) / m) * 1e4);
    out[i++] = squash(Math.log(Math.max(bidDepth, 1e-9) / Math.max(askDepth, 1e-9)));
    out[i++] = squash(((b1 - bidFar) / m) * 1e4);
    out[i++] = squash(((askFar - a1) / m) * 1e4);
    out[i++] = squash(zBid);
    out[i++] = squash(zAsk);
    out[i++] = squash(zCount);
    out[i++] = squash(zDepthMsgs);
    out[i++] = squash(zVol);
    out[i++] = squash(0.5 * Math.log(Math.max(this.varShort, 1e-14) / Math.max(this.varLong, 1e-14)));
    out[i++] = squash(Math.log(1 + Math.max(0, (s.t - this.lastTradeTs) / 1000)) - 1);
    return out;
  }
}
