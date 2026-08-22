"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "./use-auth";
import { fetchTransactions, type TransactionsParams } from "@/lib/api/transactions";
import type { FundingTx } from "@/lib/types/funding-tx";

// wallet mutation(deposit/withdraw/transfer) 후 invalidate 대상.
export const TRANSACTIONS_KEY = ["account", "transactions"] as const;

export function useTransactions(params: TransactionsParams = {}) {
  const { data: user } = useCurrentUser();

  return useQuery<FundingTx[]>({
    queryKey: [
      ...TRANSACTIONS_KEY,
      params.type ?? "all",
      params.asset ?? "all",
      params.limit ?? null,
      params.endTime ?? null,
    ],
    queryFn: () => fetchTransactions(params),
    enabled: user != null,
  });
}
