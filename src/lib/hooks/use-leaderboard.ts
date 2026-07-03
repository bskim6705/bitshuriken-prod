"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchLeaderboard, type LeaderboardParams } from "@/lib/api/leaderboard";
import type { LeaderboardResponse } from "@/lib/types/leaderboard";

export const LEADERBOARD_KEY = ["leaderboard"] as const;

export function useLeaderboard(params: LeaderboardParams = {}) {
  return useQuery<LeaderboardResponse>({
    queryKey: [
      ...LEADERBOARD_KEY,
      params.window ?? "WEEKLY",
      params.metric ?? "ROI",
      params.limit ?? null,
    ],
    queryFn: () => fetchLeaderboard(params),
    staleTime: 30_000,
  });
}
