import type { MarketType } from "./market";

export type FundingTxType = "DEPOSIT" | "WITHDRAWAL" | "TRANSFER";

// BE account transaction row JSON 그대로 (Decimal → fixed-8 string, time → epoch ms)
export interface FundingTx {
  id: string;
  type: FundingTxType;
  assetSymbol: string;
  qty: string;
  fromMarket: MarketType | null;
  toMarket: MarketType | null;
  status: string;
  time: number;
}
