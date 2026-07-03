import { portalApi } from "./client";
import type {
  LeaderboardMetric,
  LeaderboardResponse,
  LeaderboardWindow,
} from "@/lib/types/leaderboard";

export interface LeaderboardParams {
  window?: LeaderboardWindow;
  metric?: LeaderboardMetric;
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

// 공개 트레이딩 리더보드 — 로그인 불필요.
export function fetchLeaderboard(params: LeaderboardParams = {}): Promise<LeaderboardResponse> {
  return portalApi.get<LeaderboardResponse>(`/leaderboard${buildQuery({ ...params })}`);
}
