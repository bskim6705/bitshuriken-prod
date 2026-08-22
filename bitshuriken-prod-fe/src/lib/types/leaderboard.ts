export type LeaderboardMetric = "ROI" | "PNL" | "VOLUME";
export type LeaderboardWindow = "DAILY" | "WEEKLY" | "MONTHLY" | "ALL";

// BE 리더보드 1행. roi=퍼센트 string, pnl/volume/equity=USDT string(8dp). 미평가 시 null.
export interface LeaderboardEntry {
  rank: number;
  userId: string;
  name: string; // displayName 또는 마스킹 이메일
  roi: string | null;
  pnl: string | null;
  volume: string;
  startEquity: string | null;
  endEquity: string | null;
}

export interface LeaderboardResponse {
  window: LeaderboardWindow;
  metric: LeaderboardMetric;
  rows: LeaderboardEntry[];
}
