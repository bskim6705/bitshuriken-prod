"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "./use-auth";
import { fetchAccountHistory, type AccountHistoryParams } from "@/lib/api/account-history";
import type { UnifiedTx } from "@/lib/types/account-history";

export const ACCOUNT_HISTORY_KEY = ["account", "history"] as const;

export function useAccountHistory(params: AccountHistoryParams = {}) {
  const { data: user } = useCurrentUser();

  return useQuery<UnifiedTx[]>({
    queryKey: [
      ...ACCOUNT_HISTORY_KEY,
      params.type ?? "all",
      params.asset ?? "all",
      params.startTime ?? null,
      params.endTime ?? null,
      params.limit ?? null,
    ],
    queryFn: () => fetchAccountHistory(params),
    enabled: user != null,
  });
}
