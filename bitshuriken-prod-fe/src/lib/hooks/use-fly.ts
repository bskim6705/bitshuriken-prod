"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchFlyDetail, fetchFlyLeague } from "@/lib/api/fly";
import type { FlyDetail, FlyLeagueSummary } from "@/lib/types/fly";

export const FLY_LEAGUE_KEY = ["fly", "league"] as const;

/** 리그 순위표 — 2초 폴링 (파리는 1초에 한 번 결정한다). */
export function useFlyLeague() {
  return useQuery<FlyLeagueSummary>({
    queryKey: FLY_LEAGUE_KEY,
    queryFn: fetchFlyLeague,
    refetchInterval: 2_000,
    staleTime: 1_000,
    retry: 1,
  });
}

/** 선택한 파리의 뇌 스냅샷. */
export function useFlyDetail(slot: number | null) {
  return useQuery<FlyDetail | null>({
    queryKey: ["fly", "detail", slot],
    queryFn: () => fetchFlyDetail(slot as number),
    enabled: slot !== null,
    refetchInterval: 2_000,
    staleTime: 1_000,
    retry: 1,
  });
}
