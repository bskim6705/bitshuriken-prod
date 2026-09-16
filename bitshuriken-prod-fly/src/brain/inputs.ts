import { BAR_FEATURES, type FeatureSpec } from './features';
import { LOB_FEATURES } from '../lob/features';

/** 뇌 입력 종류 — 모델 파일에 기록되고, 감각 투사(FlyBrain)와 라이브 데이터 경로를 결정한다. */
export type InputKind = 'bars' | 'lob';

export function specsFor(kind: InputKind): readonly FeatureSpec[] {
  return kind === 'lob' ? LOB_FEATURES : BAR_FEATURES;
}
