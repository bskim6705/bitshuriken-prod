"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  authApi,
  type LoginHistoryEntry,
  type SessionInfo,
  type TwoFactorSetup,
  type UserProfile,
} from "@/lib/api/auth";

// Mirrors the query key used by useCurrentUser in use-auth.ts.
const ME_KEY = ["auth", "me"] as const;
const SESSIONS_KEY = ["auth", "sessions"] as const;
const LOGIN_HISTORY_KEY = ["auth", "login-history"] as const;

/** Begin 2FA enrollment — returns the secret, otpauth URL, and QR data-URL. */
export function useSetup2fa() {
  return useMutation<TwoFactorSetup, Error, void>({
    mutationFn: () => authApi.setup2fa(),
  });
}

export function useEnable2fa() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (code: string) => authApi.enable2fa(code),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export function useDisable2fa() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (code: string) => authApi.disable2fa(code),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export function useResendVerification() {
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: () => authApi.resendVerification(),
  });
}

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation<
    { ok: true },
    Error,
    { oldPassword: string; newPassword: string; totpCode?: string }
  >({
    mutationFn: ({ oldPassword, newPassword, totpCode }) =>
      authApi.changePassword(oldPassword, newPassword, totpCode),
    onSuccess: () => {
      // 다른 세션이 무효화되므로 세션 목록 갱신
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });
}

export function useSessions() {
  return useQuery<SessionInfo[], Error>({
    queryKey: SESSIONS_KEY,
    queryFn: () => authApi.listSessions(),
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id: string) => authApi.revokeSession(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });
}

export function useRevokeOtherSessions() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: () => authApi.revokeOtherSessions(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });
}

export function useLoginHistory() {
  return useQuery<LoginHistoryEntry[], Error>({
    queryKey: LOGIN_HISTORY_KEY,
    queryFn: () => authApi.loginHistory(),
  });
}

export function useSetAntiPhishing() {
  const qc = useQueryClient();
  return useMutation<UserProfile, Error, { code: string | null; totpCode?: string }>({
    mutationFn: ({ code, totpCode }) => authApi.setAntiPhishing(code, totpCode),
    onSuccess: (profile) => {
      qc.setQueryData(ME_KEY, profile);
    },
  });
}
