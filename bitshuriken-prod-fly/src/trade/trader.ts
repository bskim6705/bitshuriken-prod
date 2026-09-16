import { existsSync } from 'node:fs';
import type { Bar } from '../core/types';
import { FlyBrain, type PopulationActivity } from '../brain/brain';
import { Connectome } from '../brain/connectome';
import { BAR_FEATURES, BarFeatures } from '../brain/features';
import { loadModel, type FlyModel } from '../brain/model';
import { connectomePath, modelPath } from '../brain/paths';
import { predict, type Readout } from '../brain/readout';
import { DEFAULT_POLICY, decide, exposureOf, type AccountView, type Decision, type PolicyParams } from './policy';

/** 뇌 활동 스냅샷 — 대시보드가 그리는 것. */
export interface BrainSnapshot {
  t: number;
  price: number;
  yhat: number;
  yScale: number;
  exposure: number;
  populations: PopulationActivity[];
  descending: number[];
}

/** 피처 통계 100 + 뇌 자리잡기 200. 그 전 bar는 관찰만. */
export const WARMUP_BARS = 300;
const HISTORY = 300;

/**
 * 초파리 트레이더 = 커넥톰 뇌 + 감각 인코더 + 하강뉴런 판독 + 노출 정책. 라이브와 백테스트가 같은 객체를
 * 쓴다 — 차이는 주문이 어디로 가는가뿐.
 */
export class FlyTrader {
  readonly brain: FlyBrain;
  readonly fx = new BarFeatures();
  readonly readout: Readout;
  barsSinceTrade = Infinity;
  private bars = 0;
  snapshot: BrainSnapshot | null = null;
  readonly history: { t: number; yhat: number; exposure: number }[] = [];

  constructor(
    readonly model: FlyModel,
    conn: Connectome,
    readonly policy: PolicyParams = DEFAULT_POLICY,
  ) {
    if ((model.inputKind ?? 'bars') !== 'bars') throw new Error(`FlyTrader is the bar-input path; model ${model.symbol} is ${model.inputKind} — use the lob live/evolve path`);
    this.brain = new FlyBrain(conn, model.brain, BAR_FEATURES);
    this.readout = { dim: model.readout.dim, w: Float32Array.from(model.readout.w), b: model.readout.b };
  }

  /** data/fly/models/<SYMBOL>-<interval>.json + 그 모델이 학습된 커넥톰. 없으면 명확히 실패. */
  static load(symbol: string, interval: string, policy?: Partial<PolicyParams>, modelFile?: string): FlyTrader {
    const path = modelFile ?? modelPath(symbol, interval);
    if (!existsSync(path)) throw new Error(`no trained model at ${path} — run: npm run fly train ${symbol} ${interval} 30`);
    const model = loadModel(path);
    if (model.interval !== interval) throw new Error(`model ${path} is for ${model.interval} bars, not ${interval}`);
    const conn = Connectome.load(connectomePath(model.connectome.region));
    if (conn.N !== model.connectome.N || conn.E !== model.connectome.E) {
      throw new Error(`connectome ${model.connectome.region} (N=${conn.N}, E=${conn.E}) differs from the model's (N=${model.connectome.N}, E=${model.connectome.E}) — retrain`);
    }
    return new FlyTrader(model, conn, { ...DEFAULT_POLICY, ...policy });
  }

  get warm(): boolean {
    return this.bars >= WARMUP_BARS;
  }

  /** bar → 피처 → 뇌 한 스텝 → ŷ. 피처 미준비면 null. */
  observe(bar: Bar): number | null {
    this.bars++;
    this.barsSinceTrade++;
    const f = this.fx.update(bar);
    if (!f) return null;
    this.brain.step(f);
    const yhat = predict(this.readout, this.brain.descending());
    const exposure = exposureOf(yhat, this.model.yScale);
    this.history.push({ t: bar.closeTime, yhat, exposure });
    if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
    this.snapshot = {
      t: bar.closeTime,
      price: bar.close,
      yhat,
      yScale: this.model.yScale,
      exposure,
      populations: this.brain.activity(),
      descending: Array.from(this.brain.descending(), (v) => Math.round(v * 1000) / 1000),
    };
    return yhat;
  }

  /** warmup이 끝났고 ŷ가 있으면 정책 결정. 실행한 쪽이 markTraded()를 호출한다. */
  decide(yhat: number, acct: AccountView): Decision {
    if (!this.warm) return { kind: 'HOLD', reason: 'warming up' };
    return decide(exposureOf(yhat, this.model.yScale), acct, this.barsSinceTrade, this.policy);
  }

  markTraded(): void {
    this.barsSinceTrade = 0;
  }
}
