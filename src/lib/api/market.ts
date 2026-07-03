import { api } from "./client";
import type { ExchangeInfo, Kline } from "@/lib/types/market";

export function fetchExchangeInfo(): Promise<ExchangeInfo> {
  return api.get<ExchangeInfo>("/spot/market/exchange-info");
}

export function fetchKlines(
  symbol: string,
  interval: string,
  limit: number,
  endTime?: number,
): Promise<Kline[]> {
  const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (endTime !== undefined) params.set("endTime", String(endTime));
  return api.get<Kline[]>(`/spot/market/klines?${params.toString()}`);
}
