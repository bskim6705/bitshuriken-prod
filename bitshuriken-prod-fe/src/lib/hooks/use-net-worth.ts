"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "./use-auth";
import { fetchNetWorth, type NetWorthParams } from "@/lib/api/net-worth";
import type { NetWorthPoint } from "@/lib/types/net-worth";

export const NET_WORTH_KEY = ["account", "net-worth"] as const;

export function useNetWorth(params: NetWorthParams = {}) {
  const { data: user } = useCurrentUser();

  return useQuery<NetWorthPoint[]>({
    queryKey: [...NET_WORTH_KEY, params.from ?? null, params.to ?? null],
    queryFn: () => fetchNetWorth(params),
    enabled: user != null,
  });
}
