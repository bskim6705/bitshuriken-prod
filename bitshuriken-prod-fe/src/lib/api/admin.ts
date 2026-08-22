import { portalApi } from "./client";
import type {
  AdminOverview,
  AdminTicker,
  AdminUserDetail,
  AdminUserList,
  Market,
  TickerStatus,
} from "@/lib/types/admin";
import type { UserRole } from "@/lib/api/auth";

export interface RestrictionsBody {
  loginEnabled?: boolean;
  tradingEnabled?: boolean;
  withdrawalEnabled?: boolean;
  totpCode?: string;
}

export interface ListUsersParams {
  search?: string;
  limit?: number;
  offset?: number;
}

export interface AdjustBalanceBody {
  marketType: Market;
  assetSymbol: string;
  qty: string;
  reason?: string;
  totpCode?: string;
}

export interface UpdateFeeBody {
  feeMakerBps: number;
  feeTakerBps: number;
  totpCode?: string;
}

export interface AdjustmentResult {
  adjustmentId: string;
  direction: "credit" | "debit";
  marketType: Market;
  assetSymbol: string;
  qty: string;
}

export const adminApi = {
  listUsers: (params: ListUsersParams = {}) => {
    const q = new URLSearchParams();
    if (params.search) q.set("search", params.search);
    if (params.limit != null) q.set("limit", String(params.limit));
    if (params.offset != null) q.set("offset", String(params.offset));
    const qs = q.toString();
    return portalApi.get<AdminUserList>(`/admin/users${qs ? `?${qs}` : ""}`);
  },
  getUser: (userId: string) => portalApi.get<AdminUserDetail>(`/admin/users/${userId}`),

  creditBalance: (userId: string, body: AdjustBalanceBody) =>
    portalApi.post<AdjustmentResult>(`/admin/users/${userId}/balance/credit`, body),
  debitBalance: (userId: string, body: AdjustBalanceBody) =>
    portalApi.post<AdjustmentResult>(`/admin/users/${userId}/balance/debit`, body),
  updateFee: (userId: string, body: UpdateFeeBody) =>
    portalApi.patch<{ userId: string; feeMakerBps: number; feeTakerBps: number }>(
      `/admin/users/${userId}/fee`,
      body,
    ),
  revokeApiKey: (apiKeyId: string, totpCode?: string) =>
    portalApi.post<{ id: string; revokedAt: number }>(`/admin/api-keys/${apiKeyId}/revoke`, {
      totpCode,
    }),

  getOverview: () => portalApi.get<AdminOverview>("/admin/overview"),

  setRole: (userId: string, role: UserRole, totpCode?: string) =>
    portalApi.patch<{ userId: string; role: UserRole }>(`/admin/users/${userId}/role`, {
      role,
      totpCode,
    }),
  resetTwoFactor: (userId: string, totpCode?: string) =>
    portalApi.post<{ userId: string; twoFactorEnabled: boolean }>(
      `/admin/users/${userId}/reset-2fa`,
      { totpCode },
    ),
  verifyEmail: (userId: string, totpCode?: string) =>
    portalApi.post<{ userId: string; emailVerified: boolean }>(
      `/admin/users/${userId}/verify-email`,
      { totpCode },
    ),
  setRestrictions: (userId: string, body: RestrictionsBody) =>
    portalApi.patch<{
      userId: string;
      loginEnabled: boolean;
      tradingEnabled: boolean;
      withdrawalEnabled: boolean;
    }>(`/admin/users/${userId}/restrictions`, body),

  listTickers: () => portalApi.get<AdminTicker[]>("/admin/tickers"),
  setTickerStatus: (market: Market, symbol: string, status: TickerStatus, totpCode?: string) =>
    portalApi.patch<{
      symbol: string;
      marketType: Market;
      status: TickerStatus;
      previousStatus: TickerStatus;
    }>(`/admin/tickers/${market}/${symbol}/status`, { status, totpCode }),
};
