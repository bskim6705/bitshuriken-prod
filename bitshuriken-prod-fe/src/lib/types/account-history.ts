import type { MarketType } from "./market";

export type UnifiedTxType =
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "TRANSFER"
  | "REALIZED_PNL"
  | "COMMISSION"
  | "FUNDING_FEE"
  | "LIQUIDATION_FEE"
  | "INSURANCE_CLEAR"
  | "TRADE";

// 통합 변동내역 1행 (FundingTx + FuturesIncome + Trade 정규화). amount는 signed.
export interface UnifiedTx {
  id: string;
  type: UnifiedTxType;
  asset: string;
  amount: string;
  market: MarketType | null;
  time: number; // epoch ms
  detail: Record<string, unknown>;
}
