import { futuresApi, portalApi } from "./client";
import type {   Kline } from "@/lib/types/market";
import type { MyTrade } from "@/lib/types/trading";
import type {
  CreateFuturesOrderReq,
   FuturesBalance,
  FuturesExchangeInfo,
  FuturesIncome,
  FuturesIncomeType,
  FuturesOrder,
    Position,
  PositionRow,
  TransferReq,
  TransferRes,
  UpdatePositionReq } from "@/lib/types/futures";

// BE wallet row (Prisma JSON 그대로) — FUTURES만 내려온다
interface WalletRow {
  userId: string;
  assetSymbol: string;
  marketType: "SPOT" | "FUTURES";
  balance: string;
  locked: string;
  updatedAt: string;
}

export interface FuturesHistoryParams {
  symbol?: string;
  limit?: number;
  endTime?: number;
}

export interface FuturesIncomeParams {
  incomeType?: FuturesIncomeType;
  symbol?: string;
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

// ---- trading ----

export function createFuturesOrder(req: CreateFuturesOrderReq): Promise<FuturesOrder> {
  return futuresApi.post<FuturesOrder>("/futures/trading/orders", { ...req });
}

export function cancelFuturesOrder(id: string): Promise<FuturesOrder> {
  return futuresApi.del<FuturesOrder>(`/futures/trading/orders/${id}`);
}

export function updateFuturesPosition(
  symbol: string,
  req: UpdatePositionReq,
): Promise<PositionRow> {
  return futuresApi.patch<PositionRow>(`/futures/trading/positions/${symbol}`, { ...req });
}

// ---- account ----

export async function fetchFuturesBalances(): Promise<FuturesBalance[]> {
  const rows = await futuresApi.get<WalletRow[]>("/futures/account/balances");
  return rows.map((row) => ({
    asset: row.assetSymbol,
    free: row.balance,
    locked: row.locked,
    ts: new Date(row.updatedAt).getTime(),
  }));
}

export function fetchFuturesPositions(): Promise<Position[]> {
  return futuresApi.get<Position[]>("/futures/account/positions");
}

export function fetchFuturesOpenOrders(symbol?: string): Promise<FuturesOrder[]> {
  return futuresApi.get<FuturesOrder[]>(`/futures/account/open-orders${buildQuery({ symbol })}`);
}

export function fetchFuturesOrders(params: FuturesHistoryParams): Promise<FuturesOrder[]> {
  return futuresApi.get<FuturesOrder[]>(`/futures/account/orders${buildQuery({ ...params })}`);
}

export function fetchFuturesMyTrades(params: FuturesHistoryParams): Promise<MyTrade[]> {
  return futuresApi.get<MyTrade[]>(`/futures/account/trades${buildQuery({ ...params })}`);
}

export function fetchFuturesIncome(params: FuturesIncomeParams): Promise<FuturesIncome[]> {
  return futuresApi.get<FuturesIncome[]>(`/futures/account/income${buildQuery({ ...params })}`);
}

// ---- market ----

export function fetchFuturesExchangeInfo(): Promise<FuturesExchangeInfo> {
  return futuresApi.get<FuturesExchangeInfo>("/futures/market/exchange-info");
}

export function fetchFuturesKlines(
  symbol: string,
  interval: string,
  limit: number,
  endTime?: number,
): Promise<Kline[]> {
  return futuresApi.get<Kline[]>(`/futures/market/klines${buildQuery({ symbol, interval, limit, endTime })}`);
}

// ---- user data stream listenKey ----

/** 새 listenKey 발급 — /ws/fuser 만료 시 재연결용. */
export function createFuturesListenKey(): Promise<string> {
  return futuresApi
    .post<{ listenKey: string }>("/futures/account/user-data-stream")
    .then((r) => r.listenKey);
}

// ---- transfers (cross-product 경로 — /futures prefix 아님) ----

export function createTransfer(req: TransferReq): Promise<TransferRes> {
  return portalApi.post<TransferRes>("/account/transfers", { ...req });
}
