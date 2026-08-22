"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "./use-auth";
import { getUserWsClient } from "@/lib/ws/user-client";
import { debouncedInvalidate } from "@/lib/api/invalidate";
import {
  createSpotListenKey,
  fetchBalances,
  fetchCommission,
  fetchMyTrades,
  fetchOpenOrders,
  fetchOrderLists,
  fetchOrders,
  type HistoryParams,
} from "@/lib/api/account";
import {
  cancelAllOrders,
  cancelOco,
  cancelOrder,
  createOco,
  createOrder,
  type CreateOcoRes,
} from "@/lib/api/trading";
import type {
  AccountPosition,
  Balance,
  Commission,
  CreateOcoReq,
  CreateOrderReq,
  ExecutionReport,
  MyTrade,
  Order,
  OrderList,
  OrderStatus,
} from "@/lib/types/trading";

const BALANCES_KEY = ["spot", "balances"] as const;

const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
]);

// 마지막 구독 해제 시에만 disconnect (싱글톤 공유 refcount)
let userStreamRefs = 0;

/**
 * 로그인 상태에서만 user-ws 연결 유지.
 * 모든 (재)연결 시 ['spot'] prefix 캐시 invalidate — REST 재동기화.
 */
export function useUserStream(): void {
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    const client = getUserWsClient();
    client.setListenKeyProvider(createSpotListenKey);
    const offOpen = client.onOpen(() => {
      debouncedInvalidate(qc, ["spot"]);
    });
    userStreamRefs += 1;
    client.connect();
    return () => {
      offOpen();
      userStreamRefs -= 1;
      if (userStreamRefs === 0) client.disconnect();
    };
  }, [userId, qc]);
}

function toMillis(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return new Date(v).getTime();
  return 0;
}

/** 자산별 ts 비교로 순서 역전(stale) 이벤트 drop. 캐시 미적재 시 merge 생략. */
function mergeBalances(prev: Balance[] | undefined, incoming: Balance[]): Balance[] | undefined {
  if (!prev) return prev;
  const next = [...prev];
  for (const inc of incoming) {
    const ts = toMillis(inc.ts);
    const idx = next.findIndex((b) => b.asset === inc.asset);
    if (idx === -1) {
      next.push({ ...inc, ts });
      continue;
    }
    if (ts < (next[idx].ts ?? 0)) continue;
    next[idx] = { ...inc, ts };
  }
  return next;
}

export function useBalances() {
  useUserStream();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();

  const query = useQuery<Balance[]>({
    queryKey: BALANCES_KEY,
    queryFn: fetchBalances,
    enabled: user != null,
  });

  useEffect(() => {
    return getUserWsClient().on("outboundAccountPosition", (data) => {
      const pos = data as AccountPosition;
      qc.setQueryData<Balance[]>(BALANCES_KEY, (prev) => mergeBalances(prev, pos.balances));
    });
  }, [qc]);

  return query;
}

/** executionReport → Order row 형태로 변환 (캐시 upsert용). eq/cqq는 리포트 값 우선. */
function reportToOrder(report: ExecutionReport, existing: Order | undefined): Order {
  const ts = new Date(report.ts).toISOString();
  return {
    id: report.orderId,
    userId: existing?.userId ?? "",
    tickerSymbol: report.symbol,
    tickerMarket: "SPOT",
    type: report.type,
    side: report.side,
    timeInForce: report.timeInForce,
    price: report.price ?? existing?.price ?? null,
    stopPrice: report.stopPrice ?? existing?.stopPrice ?? null,
    origQty: report.origQty ?? existing?.origQty ?? null,
    origQuoteQty: report.origQuoteQty ?? existing?.origQuoteQty ?? null,
    executedQty: report.executedQty,
    cumulativeQuoteQty: report.cumulativeQuoteQty,
    status: report.status,
    triggeredAt: existing?.triggeredAt ?? null,
    orderListId: report.orderListId ?? existing?.orderListId ?? null,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  };
}

export function useOpenOrders(symbol?: string) {
  useUserStream();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();

  const query = useQuery<Order[]>({
    queryKey: ["spot", "openOrders", symbol ?? "all"],
    queryFn: () => fetchOpenOrders(symbol),
    enabled: user != null,
  });

  useEffect(() => {
    return getUserWsClient().on("executionReport", (data) => {
      const report = data as ExecutionReport;
      if (symbol && report.symbol !== symbol) return;
      qc.setQueryData<Order[]>(["spot", "openOrders", symbol ?? "all"], (prev) => {
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

export function useOrderHistory(params: HistoryParams = {}) {
  useUserStream();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();

  const query = useQuery<Order[]>({
    queryKey: [
      "spot",
      "orders",
      params.symbol ?? "all",
      params.limit ?? null,
      params.endTime ?? null,
    ],
    queryFn: () => fetchOrders(params),
    enabled: user != null,
  });

  useEffect(() => {
    return getUserWsClient().on("executionReport", () => {
      debouncedInvalidate(qc, ["spot", "orders"]);
    });
  }, [qc]);

  return query;
}

export function useMyTrades(params: HistoryParams = {}) {
  useUserStream();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();

  const query = useQuery<MyTrade[]>({
    queryKey: [
      "spot",
      "trades",
      params.symbol ?? "all",
      params.limit ?? null,
      params.endTime ?? null,
    ],
    queryFn: () => fetchMyTrades(params),
    enabled: user != null,
  });

  useEffect(() => {
    return getUserWsClient().on("executionReport", (data) => {
      const report = data as ExecutionReport;
      // 체결이 있었던 리포트만 (PARTIAL/FILLED, MARKET 부분체결 EXPIRED는 eq>0)
      const filled =
        report.status === "PARTIAL" ||
        report.status === "FILLED" ||
        Number(report.executedQty) > 0;
      if (!filled) return;
      debouncedInvalidate(qc, ["spot", "trades"]);
    });
  }, [qc]);

  return query;
}

export function useOrderLists() {
  useUserStream();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();

  const query = useQuery<OrderList[]>({
    queryKey: ["spot", "orderLists"],
    queryFn: fetchOrderLists,
    enabled: user != null,
  });

  useEffect(() => {
    return getUserWsClient().on("listStatus", () => {
      debouncedInvalidate(qc, ["spot", "orderLists"]);
    });
  }, [qc]);

  return query;
}

export function useCommission() {
  useUserStream();
  const { data: user } = useCurrentUser();
  return useQuery<Commission>({
    queryKey: ["spot", "commission"],
    queryFn: fetchCommission,
    enabled: user != null,
    staleTime: 60 * 60 * 1000,
  });
}

function invalidateAfterMutation(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ["spot", "openOrders"] });
  void qc.invalidateQueries({ queryKey: ["spot", "balances"] });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateOrderReq) => createOrder(req),
    onSuccess: () => invalidateAfterMutation(qc),
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  // OCO 레그 취소 시 BE는 {orderList, orders}로 응답
  return useMutation<Order | CreateOcoRes, Error, string>({
    mutationFn: (id: string) => cancelOrder(id),
    onSuccess: () => invalidateAfterMutation(qc),
  });
}

export function useCancelAllOrders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (symbol: string) => cancelAllOrders(symbol),
    onSuccess: () => invalidateAfterMutation(qc),
  });
}

export function useCreateOco() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateOcoReq) => createOco(req),
    onSuccess: () => {
      invalidateAfterMutation(qc);
      void qc.invalidateQueries({ queryKey: ["spot", "orderLists"] });
    },
  });
}

export function useCancelOco() {
  const qc = useQueryClient();
  return useMutation<CreateOcoRes, Error, string>({
    mutationFn: (id: string) => cancelOco(id),
    onSuccess: () => {
      invalidateAfterMutation(qc);
      void qc.invalidateQueries({ queryKey: ["spot", "orderLists"] });
    },
  });
}
