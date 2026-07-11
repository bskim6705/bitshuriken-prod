"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { InlineError } from "@/components/ui/inline-error";
import { ApiError } from "@/lib/api/client";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useChangePassword } from "@/lib/hooks/use-security";
import { useT } from "@/lib/i18n/provider";

const MIN_LENGTH = 8;
const TWO_FACTOR_REQUIRED = 60010;
const INVALID_TWO_FACTOR_CODE = 60011;

function PasswordField({
  label,
  value,
  onChange,
  disabled,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  autoComplete: "current-password" | "new-password";
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-text-dim">{label}</span>
      <PasswordInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoComplete={autoComplete}
        className="disabled:opacity-40"
      />
    </label>
  );
}

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const changeMut = useChangePassword();
  const { data: user } = useCurrentUser();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const needsTotp = user?.twoFactorEnabled === true;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const canSubmit =
    oldPassword.length > 0 &&
    newPassword.length >= MIN_LENGTH &&
    newPassword === confirm &&
    (!needsTotp || totpCode.length === 6) &&
    !changeMut.isPending;

  async function submit() {
    setError(null);
    if (newPassword.length < MIN_LENGTH) {
      setError(t("account.changePassword.tooShortMsg", { min: MIN_LENGTH }));
      return;
    }
    if (newPassword !== confirm) {
      setError(t("account.changePassword.mismatchMsg"));
      return;
    }
    try {
      await changeMut.mutateAsync({
        oldPassword,
        newPassword,
        ...(needsTotp && totpCode !== "" ? { totpCode } : {}),
      });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === INVALID_TWO_FACTOR_CODE) {
        setError(t("account.changePassword.invalidCode"));
      } else if (err instanceof ApiError && err.code === TWO_FACTOR_REQUIRED) {
        setError(t("account.changePassword.codeRequired"));
      } else if (err instanceof ApiError && err.status === 401) {
        setError(t("account.changePassword.incorrect"));
      } else {
        setError(err instanceof Error ? err.message : t("account.changePassword.failed"));
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("account.changePassword.title")}
        className="w-full max-w-[380px] bg-surface border border-line"
      >
        <header className="flex items-center justify-between px-4 h-10 border-b border-line">
          <h2 className="text-[13px] font-medium">{t("account.changePassword.title")}</h2>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="w-7 h-7 grid place-items-center text-text-dim hover:text-text"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="p-4 flex flex-col gap-3">
          {done ? (
            <>
              <p role="status" aria-live="polite" className="text-[12px] text-up">
                {t("account.changePassword.success")}
              </p>
              <Button variant="primary" onClick={onClose} className="w-full">
                {t("account.changePassword.done")}
              </Button>
            </>
          ) : (
            <>
              <PasswordField
                label={t("account.changePassword.current")}
                value={oldPassword}
                onChange={(v) => {
                  setOldPassword(v);
                  setError(null);
                }}
                disabled={changeMut.isPending}
                autoComplete="current-password"
              />
              <PasswordField
                label={t("account.changePassword.new")}
                value={newPassword}
                onChange={(v) => {
                  setNewPassword(v);
                  setError(null);
                }}
                disabled={changeMut.isPending}
                autoComplete="new-password"
              />
              <PasswordField
                label={t("account.changePassword.confirm")}
                value={confirm}
                onChange={(v) => {
                  setConfirm(v);
                  setError(null);
                }}
                disabled={changeMut.isPending}
                autoComplete="new-password"
              />

              {needsTotp && (
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-text-dim">
                    {t("account.changePassword.twoFactorCode")}
                  </span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    maxLength={6}
                    pattern="[0-9]{6}"
                    value={totpCode}
                    onChange={(e) => {
                      setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                      setError(null);
                    }}
                    disabled={changeMut.isPending}
                    className="h-9 w-full bg-raised border border-line px-3 text-[13px] text-text tnum placeholder:text-text-muted focus:outline-none focus:border-accent disabled:opacity-40"
                  />
                </label>
              )}

              {tooShort && (
                <p className="text-[11px] text-text-muted">
                  {t("account.changePassword.tooShort", { min: MIN_LENGTH })}
                </p>
              )}
              {mismatch && (
                <p className="text-[11px] text-text-muted">{t("account.changePassword.mismatch")}</p>
              )}
              {error && <InlineError>{error}</InlineError>}

              <Button
                variant="primary"
                onClick={submit}
                disabled={!canSubmit}
                className="w-full"
              >
                {changeMut.isPending
                  ? t("account.changePassword.changing")
                  : t("account.changePassword.submit")}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
