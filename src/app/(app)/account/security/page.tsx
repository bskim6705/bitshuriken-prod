"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ChangePasswordDialog } from "@/components/account/change-password-dialog";
import { TwoFactorDialog } from "@/components/account/two-factor-dialog";
import { ApiError } from "@/lib/api/client";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useResendVerification } from "@/lib/hooks/use-security";
import { useT } from "@/lib/i18n/provider";

const EMAIL_ALREADY_VERIFIED = 60015;

const COMING_SOON = [
  { labelKey: "account.security.antiPhishing.label", hintKey: "account.security.antiPhishing.hint" },
  {
    labelKey: "account.security.withdrawalWhitelist.label",
    hintKey: "account.security.withdrawalWhitelist.hint",
  },
  {
    labelKey: "account.security.activeSessions.label",
    hintKey: "account.security.activeSessions.hint",
  },
];

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
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-line">
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
          <Button
            variant="primary"
            size="sm"
            onClick={resend}
            disabled={resendMut.isPending}
          >
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
      {dialog && (
        <TwoFactorDialog mode={dialog} onClose={() => setDialog(null)} />
      )}
    </>
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
        <div className="bg-surface border border-line">
          <PasswordRow />
          <TwoFactorRow />
          <EmailVerificationRow />

          {COMING_SOON.map((it) => (
            <div
              key={it.labelKey}
              className="flex items-center justify-between px-3 py-2.5 border-b border-line last:border-b-0"
            >
              <div>
                <p className="text-[12px] text-text">{t(it.labelKey)}</p>
                <p className="text-[11px] text-text-dim mt-0.5">{t(it.hintKey)}</p>
                <p className="text-[11px] text-text-muted mt-0.5">{t("account.security.comingSoon")}</p>
              </div>
              <Button variant="outline" size="sm" disabled>
                {t("account.security.manage")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
