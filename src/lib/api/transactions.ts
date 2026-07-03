import { portalApi } from "./client";
import type { FundingTx, FundingTxType } from "@/lib/types/funding-tx";

export interface TransactionsParams {
  type?: FundingTxType;
  asset?: string;
  limit?: number;
  endTime?: number;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

// 계정 입출금/이체 내역 — newest first. endTime은 inclusive(lte) 커서.
export function fetchTransactions(params: TransactionsParams): Promise<FundingTx[]> {
  return portalApi.get<FundingTx[]>(`/account/transactions${buildQuery({ ...params })}`);
}
