"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "./use-auth";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/api/api-keys";
import type { ApiKey, CreateApiKeyReq, IssuedApiKey } from "@/lib/types/api-key";

const API_KEYS_KEY = ["auth", "apiKeys"] as const;

export function useApiKeys() {
  const { data: user } = useCurrentUser();
  return useQuery<ApiKey[]>({
    queryKey: API_KEYS_KEY,
    queryFn: listApiKeys,
    enabled: user != null,
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation<IssuedApiKey, Error, CreateApiKeyReq>({
    mutationFn: (req: CreateApiKeyReq) => createApiKey(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: API_KEYS_KEY });
    },
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: API_KEYS_KEY });
    },
  });
}
