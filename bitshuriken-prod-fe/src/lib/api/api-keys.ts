import { portalApi } from "./client";
import type { ApiKey, CreateApiKeyReq, IssuedApiKey } from "@/lib/types/api-key";

export function listApiKeys(): Promise<ApiKey[]> {
  return portalApi.get<ApiKey[]>("/auth/api-keys");
}

export function createApiKey(req: CreateApiKeyReq): Promise<IssuedApiKey> {
  return portalApi.post<IssuedApiKey>("/auth/api-keys", { ...req });
}

export async function revokeApiKey(id: string): Promise<void> {
  await portalApi.del<void>(`/auth/api-keys/${id}`);
}
