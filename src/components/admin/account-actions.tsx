"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Badge } from "@/components/admin/ui";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useUserAdminActions } from "@/lib/hooks/use-admin";
import { useT } from "@/lib/i18n/provider";
import type { AdminUserDetail } from "@/lib/types/admin";

type AdminUser = AdminUserDetail["user"];

function Switch({
  label,
  ariaLabel,
  enabled,
  disabled,
  onToggle,
}: {
  label: string;
  ariaLabel: string;
  enabled: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-3 h-9 px-3 bg-raised border border-line">
      <span className="flex items-center gap-2">
        <span className="text-[12px]">{label}</span>
        <Badge tone={enabled ? "up" : "down"}>{enabled ? t("admin.account.enabled") : t("admin.account.blocked")}</Badge>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={onToggle}
        className={`relative w-9 h-5 shrink-0 transition-colors disabled:opacity-40 ${
          enabled ? "bg-up" : "bg-line-strong"
        }`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 bg-white transition-all ${enabled ? "left-[18px]" : "left-0.5"}`}
        />
      </button>
    </div>
  );
}

export function AccountActions({ user }: { user: AdminUser }) {
  const t = useT();
  const { data: admin } = useCurrentUser();
  const { setRole, resetTwoFactor, verifyEmail, setRestrictions } = useUserAdminActions(user.id);
  const [totp, setTotp] = useState("");
  const [error, setError] = useState<string | null>(null);

  const needsTotp = admin?.twoFactorEnabled === true;
  const isSelf = admin?.id === user.id;
  const code = () => (needsTotp && totp ? { totpCode: totp } : {});
  const totpArg = () => (needsTotp && totp ? totp : undefined);
  const busy =
    setRestrictions.isPending || setRole.isPending || resetTwoFactor.isPending || verifyEmail.isPending;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("admin.account.actionFailed"));
    }
  }

  const toggleAria = (enabled: boolean, target: string) =>
    t("admin.account.toggleAria", {
      action: enabled ? t("admin.account.toggleDisable") : t("admin.account.toggleEnable"),
      target,
    });

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1.5">
        <h3 className="text-[12px] font-medium">{t("admin.account.title")}</h3>
        {needsTotp && (
          <input
            value={totp}
            onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            placeholder={t("admin.account.your2fa")}
            aria-label={t("admin.account.your2faAria")}
            className="h-7 w-24 bg-surface border border-line px-2 text-[11px] tnum focus:outline-none focus:border-accent"
          />
        )}
      </div>
      <div className="bg-surface border border-line p-3 flex flex-col gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Switch
            label={t("admin.account.login")}
            ariaLabel={toggleAria(user.loginEnabled, t("admin.account.login"))}
            enabled={user.loginEnabled}
            disabled={busy}
            onToggle={() => run(() => setRestrictions.mutateAsync({ loginEnabled: !user.loginEnabled, ...code() }))}
          />
          <Switch
            label={t("admin.account.trading")}
            ariaLabel={toggleAria(user.tradingEnabled, t("admin.account.trading"))}
            enabled={user.tradingEnabled}
            disabled={busy}
            onToggle={() => run(() => setRestrictions.mutateAsync({ tradingEnabled: !user.tradingEnabled, ...code() }))}
          />
          <Switch
            label={t("admin.account.withdrawal")}
            ariaLabel={toggleAria(user.withdrawalEnabled, t("admin.account.withdrawal"))}
            enabled={user.withdrawalEnabled}
            disabled={busy}
            onToggle={() =>
              run(() => setRestrictions.mutateAsync({ withdrawalEnabled: !user.withdrawalEnabled, ...code() }))
            }
          />
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || isSelf}
            onClick={() =>
              run(() => setRole.mutateAsync({ role: user.role === "ADMIN" ? "USER" : "ADMIN", ...code() }))
            }
          >
            {user.role === "ADMIN" ? t("admin.account.demote") : t("admin.account.promote")}
          </Button>
          {isSelf && <span className="text-[11px] text-text-muted">{t("admin.account.cantChangeOwnRole")}</span>}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !user.twoFactorEnabled}
            onClick={() => run(() => resetTwoFactor.mutateAsync(totpArg()))}
          >
            {t("admin.account.reset2fa")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || user.emailVerified}
            onClick={() => run(() => verifyEmail.mutateAsync(totpArg()))}
          >
            {user.emailVerified ? t("admin.account.emailVerified") : t("admin.account.forceVerifyEmail")}
          </Button>
        </div>

        {error && <InlineError>{error}</InlineError>}
      </div>
    </div>
  );
}
