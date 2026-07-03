import type { MarketType } from "./market";

export interface NetWorthBreakdownRow {
  market: MarketType;
  asset: string;
  qty: string;
  valueUsdt: string;
}

// BE BalanceSnapshot 1행 — 일별 순자산(총액 + spot/futures 분리 + per-asset breakdown).
export interface NetWorthPoint {
  day: string; // "YYYY-MM-DD" (UTC)
  time: number; // epoch ms
  totalUsdt: string;
  spotUsdt: string;
  futuresUsdt: string;
  breakdown: NetWorthBreakdownRow[];
}
