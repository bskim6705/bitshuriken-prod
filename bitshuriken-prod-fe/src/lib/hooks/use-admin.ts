"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminApi,
  type AdjustBalanceBody,
  type ListUsersParams,
  type RestrictionsBody,
  type UpdateFeeBody,
} from "@/lib/api/admin";
import type { UserRole } from "@/lib/api/auth";
import type { Market, TickerStatus } from "@/lib/types/admin";

export function useAdminUsers(params: ListUsersParams) {
  return useQuery({
    queryKey: ["admin", "users", params],
    queryFn: () => adminApi.listUsers(params),
  });
}

export function useAdminUser(userId: string) {
  return useQuery({
    queryKey: ["admin", "user", userId],
    queryFn: () => adminApi.getUser(userId),
    enabled: !!userId,
  });
}

export function useAdjustBalance(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ direction, body }: { direction: "credit" | "debit"; body: AdjustBalanceBody }) =>
      direction === "credit"
        ? adminApi.creditBalance(userId, body)
        : adminApi.debitBalance(userId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "user", userId] }),
  });
}

export function useUpdateFee(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateFeeBody) => adminApi.updateFee(userId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "user", userId] }),
  });
}

export function useRevokeApiKey(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ apiKeyId, totpCode }: { apiKeyId: string; totpCode?: string }) =>
      adminApi.revokeApiKey(apiKeyId, totpCode),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "user", userId] }),
  });
}

export function useAdminOverview() {
  return useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => adminApi.getOverview(),
  });
}

/** 유저 계정 조치(role/2FA리셋/이메일인증/제한) — 성공 시 유저 상세 + 목록 갱신. */
export function useUserAdminActions(userId: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin", "user", userId] });
    qc.invalidateQueries({ queryKey: ["admin", "users"] });
    qc.invalidateQueries({ queryKey: ["admin", "overview"] });
  };

  const setRole = useMutation({
    mutationFn: ({ role, totpCode }: { role: UserRole; totpCode?: string }) =>
      adminApi.setRole(userId, role, totpCode),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["auth", "me"] }); // 본인 role 변경 대비
    },
  });
  const resetTwoFactor = useMutation({
    mutationFn: (totpCode?: string) => adminApi.resetTwoFactor(userId, totpCode),
    onSuccess: invalidate,
  });
  const verifyEmail = useMutation({
    mutationFn: (totpCode?: string) => adminApi.verifyEmail(userId, totpCode),
    onSuccess: invalidate,
  });
  const setRestrictions = useMutation({
    mutationFn: (body: RestrictionsBody) => adminApi.setRestrictions(userId, body),
    onSuccess: invalidate,
  });

  return { setRole, resetTwoFactor, verifyEmail, setRestrictions };
}

export function useAdminTickers() {
  return useQuery({
    queryKey: ["admin", "tickers"],
    queryFn: () => adminApi.listTickers(),
  });
}

export function useSetTickerStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      market,
      symbol,
      status,
      totpCode,
    }: {
      market: Market;
      symbol: string;
      status: TickerStatus;
      totpCode?: string;
    }) => adminApi.setTickerStatus(market, symbol, status, totpCode),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "tickers"] }),
  });
}
