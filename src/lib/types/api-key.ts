// API 키 관리 — portal /auth/api-keys

// GET /auth/api-keys 목록 항목 (secret 없음)
export interface ApiKey {
  id: string;
  apiKey: string;
  label: string | null;
  canTrade: boolean;
  canRead: boolean;
  ipWhitelist: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

// POST /auth/api-keys 응답 — secret은 평문, 이 응답에서만 1회 노출
export interface IssuedApiKey {
  id: string;
  apiKey: string;
  secret: string;
  label: string | null;
  canTrade: boolean;
  canRead: boolean;
  createdAt: string;
}

export interface CreateApiKeyReq {
  label?: string;
  canRead?: boolean;
  canTrade?: boolean;
  /** 6-digit TOTP code — sent when the account has 2FA enabled. */
  totpCode?: string;
}
