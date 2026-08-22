import { portalApi } from "./client";
import type { UnifiedTx, UnifiedTxType } from "@/lib/types/account-history";

export interface AccountHistoryParams {
  type?: UnifiedTxType;
  asset?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

// 통합 변동내역 — newest first. type 미지정=섞어서(All), 지정=해당 타입만(각각).
export function fetchAccountHistory(params: AccountHistoryParams = {}): Promise<UnifiedTx[]> {
  return portalApi.get<UnifiedTx[]>(`/account/history${buildQuery({ ...params })}`);
}
