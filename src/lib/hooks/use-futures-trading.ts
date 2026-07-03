"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "./use-auth";
import { getFuturesUserWs, useFuturesUserStream } from "./use-futures-user";
import {
  cancelFuturesOrder,
  createFuturesOrder,
  createTransfer,
  fetchFuturesBalances,
  fetchFuturesIncome,
  fetchFuturesMyTrades,
  fetchFuturesOpenOrders,
  fetchFuturesOrders,
  fetchFuturesPositions,
  updateFuturesPosition,
  type FuturesHistoryParams,
  type FuturesIncomeParams,
} from "@/lib/api/futures";
import type { MyTrade, OrderStatus } from "@/lib/types/trading";
import type {
  CreateFuturesOrderReq,
  FuturesAccountPosition,
  FuturesBalance,
  FuturesExecutionReport,
  FuturesIncome,
  FuturesOrder,
  FuturesPositionSnapshot,
  FuturesPositionUpdate,
  Position,
  TransferReq,
  UpdatePositionReq,
} from "@/lib/types/futures";

const BALANCES_KEY = ["futures", "balances"] as const;
const POSITIONS_KEY = ["futures", "positions"] as const;

const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
]);

/** 자산별 ts 비교로 순서 역전(stale) 이벤트 drop. 캐시 미적재 시 merge 생략. */
function mergeBalances(
  prev: FuturesBalance[] | undefined,
  incoming: FuturesBalance[],
): FuturesBalance[] | undefined {
  if (!prev) return prev;
  const next = [...prev];
  for (const inc of incoming) {
    const idx = next.findIndex((b) => b.asset === inc.asset);
    if (idx === -1) {
      next.push(inc);
      continue;
    }
    if (inc.ts < next[idx].ts) continue;
    next[idx] = inc;
  }
  return next;
}

export function useFuturesBalances() {
  useFuturesUserStream();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();

  const query = useQuery<FuturesBalance[]>({
    queryKey: BALANCES_KEY,
    queryFn: fetchFuturesBalances,
    enabled: user != null,
  });

  useEffect(() => {
    return getFuturesUserWs().on("outboundAccountPosition", (data) => {
      const pos = data as FuturesAccountPosition;
      qc.setQueryData<FuturesBalance[]>(BALANCES_KEY, (prev) =>
        mergeBalances(prev, pos.balances),
      );
    });
  }, [qc]);

  return query;
}

/**
 * 심볼별 ts 비교 upsert. mark/UPNL/청산가는 스냅샷 값을 그대로 싣는다
 * (ISOLATED는 라이브 청산가 표시, CROSS 청산가는 null로 REST 폴이 보충).
 * marginRatio는 스냅샷에 없어 null 리셋 — REST 폴이 채운다.
 */
function mergePositions(
  prev: Position[] | undefined,
  incoming: FuturesPositionSnapshot[],
): Position[] | undefined {
  if (!prev) return prev;
  const next = [...prev];
  for (const inc of incoming) {
    const updatedAt = new Date(inc.ts).toISOString();
    const merged: Position = {
      symbol: inc.symbol,
      qty: inc.qty,
      entryPrice: inc.entryPrice,
      isolatedMargin: inc.isolatedMargin,
      leverage: inc.leverage,
      marginMode: inc.marginMode,
      status: inc.status,
      markPrice: inc.markPrice,
      unrealizedPnl: inc.unrealizedPnl,
      liquidationPrice: inc.liquidationPrice,
      marginRatio: null,
      updatedAt,
    };
    const idx = next.findIndex((p) => p.symbol === inc.symbol);
    if (idx === -1) {
      next.push(merged);
      continue;
    }
    if (inc.ts < new Date(next[idx].updatedAt).getTime()) continue;
    next[idx] = merged;
  }
  return next;
}

export function useFuturesPositions() {
  useFuturesUserStream();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();

  const query = useQuery<Position[]>({
    queryKey: POSITIONS_KEY,
    queryFn: fetchFuturesPositions,
    enabled: user != null,
  });

  useEffect(() => {
    return getFuturesUserWs().on("positionUpdate", (data) => {
      const update = data as FuturesPositionUpdate;
      qc.setQueryData<Position[]>(POSITIONS_KEY, (prev) =>
        mergePositions(prev, update.positions),
      );
    });
  }, [qc]);

  return query;
}

/** executionReport → FuturesOrder row 형태로 변환 (캐시 upsert용). eq/cqq는 리포트 값 우선. */
function reportToOrder(
  report: FuturesExecutionReport,
  existing: FuturesOrder | undefined,
): FuturesOrder {
  const ts = new Date(report.ts).toISOString();
  return {
    id: report.orderId,
    userId: existing?.userId ?? "",
    tickerSymbol: report.symbol,
    tickerMarket: "FUTURES",
    type: report.type,
    side: report.side,
    timeInForce: report.timeInForce,
    price: report.price ?? existing?.price ?? null,
    stopPrice: existing?.stopPrice ?? null,
    origQty: report.origQty ?? existing?.origQty ?? null,
    origQuoteQty: existing?.origQuoteQty ?? null,
    executedQty: report.executedQty,
    cumulativeQuoteQty: report.cumulativeQuoteQty,
    status: report.status,
    triggeredAt: existing?.triggeredAt ?? null,
    orderListId: existing?.orderListId ?? null,
    reduceOnly: report.reduceOnly,
    liquidation: existing?.liquidation ?? false,
    lockedCost: existing?.lockedCost ?? null,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  };
}

export function useFuturesOpenOrders(symbol?: string) {
  useFuturesUserStream();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();

  const query = useQuery<FuturesOrder[]>({
    queryKey: ["futures", "openOrders", symbol ?? "all"],
    queryFn: () => fetchFuturesOpenOrders(symbol),
    enabled: user != null,
  });

  useEffect(() => {
    return getFuturesUserWs().on("executionReport", (data) => {
      const report = data as FuturesExecutionReport;
      if (symbol && report.symbol !== symbol) return;
      qc.setQueryData<FuturesOrder[]>(["futures", "openOrders", symbol ?? "all"], (prev) => {
        if (!prev) return prev;
        if (TERMINAL_STATUSES.has(report.status)) {
          return prev.filter((o) => o.id !== report.orderId);
        }
        const existing = prev.find((o) => o.id === report.orderId);
        const next = reportToOrder(report, existing);
        if (existing) return prev.map((o) => (o.id === report.orderId ? next : o));
        return [next, ...prev];
      });
    });
  }, [qc, symbol]);

  return query;
}

export function useFuturesOrderHistory(params: FuturesHistoryParams = {}) {
  useFuturesUserStream();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();

  const query = useQuery<FuturesOrder[]>({
    queryKey: [
      "futures",
      "orders",
      params.symbol ?? "all",
      params.limit ?? null,
      params.endTime ?? null,
    ],
    queryFn: () => fetchFuturesOrders(params),
    enabled: user != null,
  });

  useEffect(() => {
    return getFuturesUserWs().on("executionReport", () => {
      void qc.invalidateQueries({ queryKey: ["futures", "orders"] });
    });
  }, [qc]);

  return query;
}

export function useFuturesMyTrades(params: FuturesHistoryParams = {}) {
  useFuturesUserStream();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();

  const query = useQuery<MyTrade[]>({
    queryKey: [
      "futures",
      "trades",
      params.symbol ?? "all",
      params.limit ?? null,
      params.endTime ?? null,
    ],
    queryFn: () => fetchFuturesMyTrades(params),
    enabled: user != null,
  });

  useEffect(() => {
    return getFuturesUserWs().on("executionReport", (data) => {
      const report = data as FuturesExecutionReport;
      // 체결이 있었던 리포트만 (PARTIAL/FILLED, IOC 부분체결 EXPIRED는 eq>0)
      const filled =
        report.status === "PARTIAL" ||
        report.status === "FILLED" ||
        Number(report.executedQty) > 0;
      if (!filled) return;
      void qc.invalidateQueries({ queryKey: ["futures", "trades"] });
    });
  }, [qc]);

  return query;
}

export function useFuturesIncome(params: FuturesIncomeParams = {}) {
  useFuturesUserStream();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();

  const query = useQuery<FuturesIncome[]>({
    queryKey: [
      "futures",
      "income",
      params.incomeType ?? "all",
      params.symbol ?? "all",
      params.limit ?? null,
    ],
    queryFn: () => fetchFuturesIncome(params),
    enabled: user != null,
  });

  useEffect(() => {
    // income insert는 정산 apply 트랜잭션과 동일 — 잔고 이벤트가 정산 완료 신호
    return getFuturesUserWs().on("outboundAccountPosition", () => {
      void qc.invalidateQueries({ queryKey: ["futures", "income"] });
    });
  }, [qc]);

  return query;
}

function invalidateAfterMutation(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ["futures", "openOrders"] });
  void qc.invalidateQueries({ queryKey: BALANCES_KEY });
}

export function useCreateFuturesOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateFuturesOrderReq) => createFuturesOrder(req),
    onSuccess: () => invalidateAfterMutation(qc),
  });
}

export function useCancelFuturesOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cancelFuturesOrder(id),
    onSuccess: () => invalidateAfterMutation(qc),
  });
}

export function useUpdateFuturesPosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ symbol, req }: { symbol: string; req: UpdatePositionReq }) =>
      updateFuturesPosition(symbol, req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: POSITIONS_KEY });
      void qc.invalidateQueries({ queryKey: BALANCES_KEY });
    },
  });
}

export function useTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: TransferReq) => createTransfer(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: BALANCES_KEY });
      void qc.invalidateQueries({ queryKey: ["futures", "income"] });
      // spot 지갑도 같은 트랜잭션으로 변동
      void qc.invalidateQueries({ queryKey: ["spot", "balances"] });
    },
  });
}
