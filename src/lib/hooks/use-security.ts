"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi, type TwoFactorSetup } from "@/lib/api/auth";

// Mirrors the query key used by useCurrentUser in use-auth.ts.
const ME_KEY = ["auth", "me"] as const;

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
  return useMutation<{ ok: true }, Error, { oldPassword: string; newPassword: string }>({
    mutationFn: ({ oldPassword, newPassword }) =>
      authApi.changePassword(oldPassword, newPassword),
  });
}
