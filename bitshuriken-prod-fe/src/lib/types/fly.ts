// bitshuriken-prod-fly 리그 API (GET /api/league, /api/fly/:slot) — 읽기 전용 관전 데이터.

export interface FlyEquityPoint {
  t: number;
  equity: number;
}

export interface FlyStanding {
  rank: number;
  slot: number;
  id: string;
  parent: string | null;
  born: number;
  seasons: number;
  status: "starting" | "warming" | "running" | "stopped" | string;
  equity: number;
  seasonStartEquity: number;
  seasonPnlPct: number;
  lifetimePnlPct: number;
  capital: number;
  ordersSeason: number;
  winRate: number;
  yhat: number | null;
  exposure: number;
  positionQty: number;
  price: number;
  lastAction: string | null;
  active: boolean;
  relegationZone: boolean;
  sparkline: FlyEquityPoint[];
}

export interface FlySeasonRecord {
  season: number;
  endedAt: number;
  table: FlyStanding[];
  relegated: string[];
  newborn: { id: string; parent: string; slot: number }[];
}

export interface FlyLeagueSummary {
  symbol: string;
  season: number;
  seasonStartedAt: number;
  seasonMs: number;
  secondsLeft: number;
  relegate: number;
  minTrades: number;
  capital: number;
  takerFeeBps: number;
  ending: boolean;
  table: FlyStanding[];
  history: FlySeasonRecord[];
  hallOfFame: {
    bestSeason: { id: string; pnlPct: number; season: number } | null;
    longestSurvivor: { id: string; seasons: number } | null;
    champions: Record<string, number>;
  };
  flies: {
    slot: number;
    id: string;
    parent: string | null;
    born: number;
    genome: {
      horizonSec: number;
      readoutGroups: number;
      lambda: number;
      policy: { thetaIn: number; thetaOut: number; minHoldSec: number; maxFrac: number };
      brain: { gain: number; leak: number; substeps: number; normP: number; inputGain: number };
    };
  }[];
}

export interface FlyPopulationActivity {
  name: string;
  n: number;
  mean: number;
  active: number;
}

/** 파리 한 마리의 라이브 상태 (뇌 스냅샷 포함). */
export interface FlyDetail {
  status: string;
  label: string | null;
  subaccountId: string;
  equity: number;
  positionQty: number;
  price: number;
  barsSeen: number;
  warm: boolean;
  policy: { thetaIn: number; thetaOut: number; minHoldSec: number; maxFrac: number; thetaInAbs: number; thetaOutAbs: number };
  model: { horizon: number; valIc: number; neurons: number; synapses: number; brain: { gain: number; leak: number; substeps: number; normP: number } };
  snapshot: {
    t: number;
    yhat: number;
    yScale: number;
    exposure: number;
    populations: FlyPopulationActivity[];
    descending: number[];
    features: number[];
  } | null;
  history: { t: number; yhat: number; exposure: number }[];
  featureNames: string[];
  fills: { time: number; isBuyer: boolean; price: string; qty: string; quoteQty: string }[];
}
