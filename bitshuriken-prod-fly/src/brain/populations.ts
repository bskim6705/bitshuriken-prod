/**
 * FlyWire FAFB v783 뉴런 집단. classification.csv(flow / super_class / class / sub_class)로 뉴런 하나를
 * 한 집단에 배정한다. build가 뉴런을 이 순서로 재배열하므로 집단은 연속 인덱스 범위다 —
 * 감각 입력(피처 주입)·하강뉴런 판독(디코더)·대시보드 활동 표시가 전부 범위 슬라이스로 끝난다.
 */
export const POPULATIONS = [
  'ORN', // 후각 수용 뉴런 (일반 냄새)
  'ORN_PHEROMONE', // 후각 수용 뉴런 (페로몬)
  'GRN', // 미각 수용 뉴런
  'MECH_JO', // 존스턴 기관 — 청각·바람·중력
  'MECH_BRISTLE', // 강모·그루밍 기계감각
  'THERMO_HYGRO', // 온도·습도 감각
  'SENSORY_OTHER',
  'ALPN', // 후각 투사 뉴런
  'ALLN', // 후각엽 국소 뉴런
  'LH', // 측각 (lateral horn)
  'KC', // 버섯체 케니언 세포
  'MBON', // 버섯체 출력 뉴런
  'DAN', // 도파민 뉴런
  'CX', // 중심 복합체
  'CENTRAL_OTHER',
  'ASCENDING',
  'DESCENDING', // 하강뉴런 — 뇌→몸. 디코더가 읽는 곳
  'MOTOR',
  'ENDOCRINE',
  'VISUAL', // 시엽 + 시각 투사/원심 + 광수용체. central 빌드에서 제외
] as const;
export type Population = (typeof POPULATIONS)[number];

export const popIndex = (p: Population): number => POPULATIONS.indexOf(p);

export interface ClassificationRow {
  flow: string;
  super_class: string;
  class: string;
  sub_class: string;
}

/** 한 뉴런의 분류 행 → 집단. 미분류(빈 class)는 CENTRAL_OTHER. */
export function classify(r: ClassificationRow): Population {
  const sc = r.super_class;
  const c = r.class;
  const sub = r.sub_class;
  if (sc === 'optic' || sc === 'visual_projection' || sc === 'visual_centrifugal') return 'VISUAL';
  if (sc === 'descending') return 'DESCENDING';
  if (sc === 'motor') return 'MOTOR';
  if (sc === 'endocrine') return 'ENDOCRINE';
  if (sc === 'ascending') return 'ASCENDING';
  if (sc === 'sensory' || sc === 'sensory_ascending') {
    if (c === 'visual' || c === 'ocellar') return 'VISUAL';
    if (c === 'olfactory') return sub === 'pheromone' ? 'ORN_PHEROMONE' : 'ORN';
    if (c === 'gustatory') return 'GRN';
    if (c === 'mechanosensory') return sub === 'wind_gravity' || sub === 'auditory' ? 'MECH_JO' : 'MECH_BRISTLE';
    if (c === 'thermosensory' || c === 'hygrosensory') return 'THERMO_HYGRO';
    return 'SENSORY_OTHER';
  }
  switch (c) {
    case 'ALPN':
      return 'ALPN';
    case 'ALLN':
    case 'ALIN':
    case 'ALON':
      return 'ALLN';
    case 'LHLN':
    case 'LHCENT':
      return 'LH';
    case 'Kenyon_Cell':
      return 'KC';
    case 'MBON':
      return 'MBON';
    case 'DAN':
    case 'MBIN':
      return 'DAN';
    case 'CX':
      return 'CX';
    case 'optic_lobe_intrinsic':
    case 'optic_lobes':
      return 'VISUAL';
    default:
      return 'CENTRAL_OTHER';
  }
}

/** 시장 피처가 들어가는 감각 집단 (모달리티). 판독은 DESCENDING 하나. */
export const SENSORY_INPUT = ['ORN', 'ORN_PHEROMONE', 'GRN', 'MECH_JO', 'MECH_BRISTLE', 'THERMO_HYGRO'] as const satisfies readonly Population[];
export type SensoryPopulation = (typeof SENSORY_INPUT)[number];
export const READOUT_POPULATION: Population = 'DESCENDING';
