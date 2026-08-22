import { portalApi } from "./client";
import type { NetWorthPoint } from "@/lib/types/net-worth";

export interface NetWorthParams {
  from?: number; // epoch ms
  to?: number; // epoch ms
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

// 일별 순자산 시계열 — oldest first.
export function fetchNetWorth(params: NetWorthParams = {}): Promise<NetWorthPoint[]> {
  return portalApi.get<NetWorthPoint[]>(`/account/net-worth${buildQuery({ ...params })}`);
}
