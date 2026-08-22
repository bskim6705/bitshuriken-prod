import { portalApi } from "./client";

export type UserRole = "USER" | "ADMIN";

export interface UserProfile {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  antiPhishingCode: string | null;
  role: UserRole;
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  ip: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface LoginHistoryEntry {
  id: string;
  ip: string;
  userAgent: string | null;
  success: boolean;
  createdAt: string;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface LoginCredentials extends Credentials {
  /** 6-digit TOTP code — sent when the account has 2FA enabled. */
  totpCode?: string;
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export const authApi = {
  signup: (body: Credentials) => portalApi.post<UserProfile>("/auth/signup", body),
  login: (body: LoginCredentials) => portalApi.post<UserProfile>("/auth/login", body),
  logout: () => portalApi.post<{ ok: true }>("/auth/logout"),
  me: () => portalApi.get<UserProfile>("/auth/me"),
  updateProfile: (displayName: string | null) =>
    portalApi.patch<UserProfile>("/auth/profile", { displayName }),

  // email verification
  verifyEmail: (token: string) => portalApi.post<{ ok: true }>("/auth/verify-email", { token }),
  resendVerification: () => portalApi.post<{ ok: true }>("/auth/verify-email/resend"),

  // password
  forgotPassword: (email: string) =>
    portalApi.post<{ ok: true }>("/auth/password/forgot", { email }),
  resetPassword: (token: string, password: string) =>
    portalApi.post<{ ok: true }>("/auth/password/reset", { token, password }),
  changePassword: (oldPassword: string, newPassword: string, totpCode?: string) =>
    portalApi.post<{ ok: true }>("/auth/password/change", { oldPassword, newPassword, totpCode }),

  // 2FA (TOTP)
  setup2fa: () => portalApi.post<TwoFactorSetup>("/auth/2fa/setup"),
  enable2fa: (code: string) => portalApi.post<{ ok: true }>("/auth/2fa/enable", { code }),
  disable2fa: (code: string) => portalApi.post<{ ok: true }>("/auth/2fa/disable", { code }),

  // sessions
  listSessions: () => portalApi.get<SessionInfo[]>("/auth/sessions"),
  revokeSession: (id: string) => portalApi.del<{ ok: true }>(`/auth/sessions/${id}`),
  revokeOtherSessions: () => portalApi.post<{ ok: true }>("/auth/sessions/revoke-others"),

  // login history
  loginHistory: () => portalApi.get<LoginHistoryEntry[]>("/auth/login-history"),

  // anti-phishing code
  setAntiPhishing: (code: string | null, totpCode?: string) =>
    portalApi.post<UserProfile>("/auth/anti-phishing", { code, totpCode }),
};
