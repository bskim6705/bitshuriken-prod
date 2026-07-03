import { api } from "./client";
import type { Balance, Commission, MyTrade, Order, OrderList } from "@/lib/types/trading";

// BE wallet row (Prisma JSON 그대로) — 모든 marketType의 지갑이 내려온다
interface WalletRow {
  userId: string;
  assetSymbol: string;
  marketType: "SPOT" | "FUTURES";
  balance: string;
  locked: string;
  updatedAt: string;
}

export interface HistoryParams {
  symbol?: string;
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

export async function fetchBalances(): Promise<Balance[]> {
  const rows = await api.get<WalletRow[]>("/spot/account/balances");
  return rows
    .filter((row) => row.marketType === "SPOT")
    .map((row) => ({
      asset: row.assetSymbol,
      free: row.balance,
      locked: row.locked,
      ts: new Date(row.updatedAt).getTime(),
    }));
}

export function fetchOpenOrders(symbol?: string): Promise<Order[]> {
  return api.get<Order[]>(`/spot/account/open-orders${buildQuery({ symbol })}`);
}

export function fetchOrders(params: HistoryParams): Promise<Order[]> {
  return api.get<Order[]>(`/spot/account/orders${buildQuery({ ...params })}`);
}

export function fetchMyTrades(params: HistoryParams): Promise<MyTrade[]> {
  return api.get<MyTrade[]>(`/spot/account/trades${buildQuery({ ...params })}`);
}

export function fetchOrderLists(): Promise<OrderList[]> {
  return api.get<OrderList[]>("/spot/account/order-lists");
}

export function fetchCommission(): Promise<Commission> {
  return api.get<Commission>("/spot/account/commission");
}

/** 새 listenKey 발급 — /ws/user 만료 시 재연결용. */
export function createSpotListenKey(): Promise<string> {
  return api.post<{ listenKey: string }>("/spot/user-data-stream").then((r) => r.listenKey);
}
