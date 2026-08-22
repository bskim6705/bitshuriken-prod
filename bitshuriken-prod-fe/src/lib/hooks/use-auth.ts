"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi, type Credentials, type LoginCredentials, type UserProfile } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";

const ME_KEY = ["auth", "me"] as const;

export function useCurrentUser() {
  return useQuery<UserProfile | null>({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await authApi.me();
      } catch (err) {
        // 401 = 비로그인. 에러가 아니라 "null user" 상태로 매핑. 그 외는 rethrow.
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

export function useSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Credentials) => authApi.signup(body),
    onSuccess: (user) => qc.setQueryData(ME_KEY, user),
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginCredentials) => authApi.login(body),
    onSuccess: (user) => qc.setQueryData(ME_KEY, user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: () => {
      qc.setQueryData(ME_KEY, null);
      qc.clear();
    },
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (displayName: string | null) => authApi.updateProfile(displayName),
    onSuccess: (user) => {
      qc.setQueryData(ME_KEY, user);
      // 리더보드 이름이 바뀌므로 재조회
      qc.invalidateQueries({ queryKey: ["leaderboard"] });
    },
  });
}
