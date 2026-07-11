"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ChangePasswordDialog } from "@/components/account/change-password-dialog";
import { TwoFactorDialog } from "@/components/account/two-factor-dialog";
import { AntiPhishingDialog } from "@/components/account/anti-phishing-dialog";
import { ApiError } from "@/lib/api/client";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import {
  useResendVerification,
  useSessions,
  useRevokeSession,
  useRevokeOtherSessions,
  useLoginHistory,
} from "@/lib/hooks/use-security";
import { useT } from "@/lib/i18n/provider";

const EMAIL_ALREADY_VERIFIED = 60015;

function formatTime(ts: string): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

function Row({
  label,
  children,
  action,
}: {
  label: string;
  children: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-line last:border-b-0">
      <div>
        <p className="text-[12px] text-text">{label}</p>
        <div className="mt-0.5">{children}</div>
      </div>
      {action}
    </div>
  );
}

function EmailVerificationRow() {
  const t = useT();
  const { data: user } = useCurrentUser();
  const resendMut = useResendVerification();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  async function resend() {
    setMessage(null);
    setError(null);
    try {
      await resendMut.mutateAsync();
      setMessage(t("account.security.email.sent"));
    } catch (err) {
      if (err instanceof ApiError && err.code === EMAIL_ALREADY_VERIFIED) {
        setMessage(t("account.security.email.alreadyVerified"));
      } else {
        setError(err instanceof Error ? err.message : t("account.security.email.sendFailed"));
      }
    }
  }

  return (
    <Row
      label={t("account.security.email.label")}
      action={
        user.emailVerified ? null : (
          <Button variant="primary" size="sm" onClick={resend} disabled={resendMut.isPending}>
            {resendMut.isPending
              ? t("account.security.email.sending")
              : t("account.security.email.resend")}
          </Button>
        )
      }
    >
      {user.emailVerified ? (
        <p className="text-[11px] text-up">{t("account.security.email.verified")}</p>
      ) : (
        <>
          <p className="text-[11px] text-text-dim">{t("account.security.email.notVerified")}</p>
          {message && <p className="text-[11px] text-up mt-0.5">{message}</p>}
          {error && <p className="text-[11px] text-down mt-0.5">{error}</p>}
        </>
      )}
    </Row>
  );
}

function PasswordRow() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row
        label={t("account.security.password.label")}
        action={
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            {t("account.security.password.change")}
          </Button>
        }
      >
        <p className="text-[11px] text-text-dim">{t("account.security.password.hint")}</p>
      </Row>
      {open && <ChangePasswordDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function TwoFactorRow() {
  const t = useT();
  const { data: user } = useCurrentUser();
  const [dialog, setDialog] = useState<"enable" | "disable" | null>(null);

  if (!user) return null;
  const enabled = user.twoFactorEnabled;

  return (
    <>
      <Row
        label={t("account.security.twoFactor.label")}
        action={
          enabled ? (
            <Button variant="outline" size="sm" onClick={() => setDialog("disable")}>
              {t("common.disable")}
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => setDialog("enable")}>
              {t("common.enable")}
            </Button>
          )
        }
      >
        {enabled ? (
          <p className="text-[11px] text-up">{t("account.security.twoFactor.enabled")}</p>
        ) : (
          <p className="text-[11px] text-text-dim">{t("account.security.twoFactor.disabledHint")}</p>
        )}
      </Row>
      {dialog && <TwoFactorDialog mode={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}

function AntiPhishingRow() {
  const t = useT();
  const { data: user } = useCurrentUser();
  const [open, setOpen] = useState(false);

  if (!user) return null;
  const code = user.antiPhishingCode;

  return (
    <>
      <Row
        label={t("account.security.antiPhishing.label")}
        action={
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            {code ? t("account.security.manage") : t("common.enable")}
          </Button>
        }
      >
        {code ? (
          <p className="text-[11px] text-up">
            {t("account.security.antiPhishing.set")} <span className="text-text tnum">{code}</span>
          </p>
        ) : (
          <p className="text-[11px] text-text-dim">{t("account.security.antiPhishing.hint")}</p>
        )}
      </Row>
      {open && <AntiPhishingDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function SessionsSection() {
  const t = useT();
  const { data: sessions, isLoading } = useSessions();
  const revokeMut = useRevokeSession();
  const revokeOthersMut = useRevokeOtherSessions();

  const hasOthers = (sessions ?? []).some((s) => !s.current);

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[12px] font-medium">{t("account.security.sessions.title")}</h3>
        {hasOthers && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => revokeOthersMut.mutate()}
            disabled={revokeOthersMut.isPending}
          >
            {t("account.security.sessions.revokeOthers")}
          </Button>
        )}
      </div>
      <div className="bg-surface border border-line">
        {isLoading && (
          <p className="px-3 py-6 text-center text-[11px] text-text-muted">{t("common.loading")}</p>
        )}
        {!isLoading && (sessions ?? []).length === 0 && (
          <p className="px-3 py-6 text-center text-[11px] text-text-muted">
            {t("account.security.sessions.empty")}
          </p>
        )}
        {(sessions ?? []).map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between px-3 py-2.5 border-b border-line last:border-b-0"
          >
            <div className="min-w-0">
              <p className="text-[12px] text-text tnum">
                {s.ip}
                {s.current && (
                  <span className="ml-2 text-[10px] text-accent">
                    {t("account.security.sessions.current")}
                  </span>
                )}
              </p>
              <p className="text-[11px] text-text-dim truncate max-w-[240px]">
                {s.userAgent ?? "—"}
              </p>
              <p className="text-[11px] text-text-muted tnum">
                {t("account.security.sessions.lastSeen")} {formatTime(s.lastSeenAt)}
              </p>
            </div>
            {!s.current && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => revokeMut.mutate(s.id)}
                disabled={revokeMut.isPending}
              >
                {t("account.security.sessions.revoke")}
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LoginHistorySection() {
  const t = useT();
  const { data: history, isLoading } = useLoginHistory();

  return (
    <div className="mt-3">
      <h3 className="text-[12px] font-medium mb-2">{t("account.security.loginHistory.title")}</h3>
      <div className="bg-surface border border-line">
        {isLoading && (
          <p className="px-3 py-6 text-center text-[11px] text-text-muted">{t("common.loading")}</p>
        )}
        {!isLoading && (history ?? []).length === 0 && (
          <p className="px-3 py-6 text-center text-[11px] text-text-muted">
            {t("account.security.loginHistory.empty")}
          </p>
        )}
        {(history ?? []).map((h) => (
          <div
            key={h.id}
            className="flex items-center justify-between px-3 py-2 border-b border-line last:border-b-0"
          >
            <div className="min-w-0">
              <p className="text-[12px] text-text tnum">{h.ip}</p>
              <p className="text-[11px] text-text-dim truncate max-w-[240px]">{h.userAgent ?? "—"}</p>
            </div>
            <div className="text-right shrink-0">
              <p className={`text-[11px] ${h.success ? "text-up" : "text-down"}`}>
                {h.success
                  ? t("account.security.loginHistory.success")
                  : t("account.security.loginHistory.failed")}
              </p>
              <p className="text-[11px] text-text-muted tnum">{formatTime(h.createdAt)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SecurityPage() {
  const t = useT();
  const { data: user, isLoading } = useCurrentUser();
  const signedOut = !isLoading && user == null;

  return (
    <div>
      <h2 className="text-[13px] font-medium mb-2">{t("account.security.title")}</h2>

      {user && (
        <div className="bg-surface border border-line px-3 py-2.5 mb-2 flex items-center justify-between">
          <span className="text-[12px] text-text-dim">{t("account.security.account")}</span>
          <span className="text-[12px] text-text tnum">{user.email}</span>
        </div>
      )}

      {isLoading && (
        <div className="bg-surface border border-line px-3 py-12 text-center text-[11px] text-text-muted">
          {t("common.loading")}
        </div>
      )}

      {signedOut && (
        <div className="bg-surface border border-line px-3 py-12 text-center text-[11px] text-text-muted">
          <Link href="/login" className="text-accent hover:underline">
            {t("auth.login.submit")}
          </Link>{" "}
          {t("account.security.loginToManage")}
        </div>
      )}

      {user && (
        <>
          <div className="bg-surface border border-line">
            <PasswordRow />
            <TwoFactorRow />
            <AntiPhishingRow />
            <EmailVerificationRow />
          </div>
          <SessionsSection />
          <LoginHistorySection />
        </>
      )}
    </div>
  );
}
