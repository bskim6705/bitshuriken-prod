import type { Connectome } from '../brain/connectome';
import type { FlyModel } from '../brain/model';
import { LOB_FEATURES } from '../lob/features';
import type { EvalResult } from './evaluate';
import type { Genome } from './genome';

/** 유전자 + 평가 결과(전 구간 재적합 판독) → 배치용 lob 모델. */
export function buildLobModel(symbol: string, g: Genome, res: EvalResult, conn: Connectome, rec: { rows: number; from: number; to: number }, generation: number): FlyModel {
  return {
    version: 1,
    kind: 'flybrain',
    symbol: symbol.toUpperCase(),
    inputKind: 'lob',
    interval: '1s',
    horizon: g.horizonSec,
    connectome: { region: conn.meta.region, N: conn.N, E: conn.E, builtAt: conn.meta.builtAt },
    brain: g.brain,
    features: LOB_FEATURES.map((f) => f.name),
    readout: res.readout,
    readoutGroups: g.readoutGroups,
    yScale: res.yScale,
    lobPolicy: g.policy,
    evo: { generation, fitness: res.fitness, netReturnPct: res.netReturnPct, winRate: res.winRate, trades: res.trades, icTest: res.icTest, recordingRows: rec.rows },
    trainedAt: new Date().toISOString(),
    train: {
      from: rec.from,
      to: rec.to,
      bars: rec.rows,
      rows: res.rows,
      lambda: g.lambda,
      val: { rows: res.testRows, meanY: 0, best: { lambda: g.lambda, ic: res.icTest, hitRate: res.winRate, topQuintileMeanY: 0 }, grid: [] },
      inSampleIc: res.icTrain,
      msPerBar: res.msPerSample,
      echoDiff: NaN,
    },
  };
}
