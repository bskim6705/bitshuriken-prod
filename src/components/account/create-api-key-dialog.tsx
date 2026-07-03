"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useCreateApiKey } from "@/lib/hooks/use-api-keys";
import type { IssuedApiKey } from "@/lib/types/api-key";
import { useT } from "@/lib/i18n/provider";

const MAX_LABEL = 64;
const TWO_FACTOR_REQUIRED = 60010;
const INVALID_TWO_FACTOR_CODE = 60011;

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 h-9 bg-raised border border-line px-3 cursor-pointer">
      <span className="flex flex-col">
        <span className="text-[12px]">{label}</span>
        <span className="text-[11px] text-text-dim">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-3.5 h-3.5 shrink-0 accent-accent"
      />
    </label>
  );
}

export function CreateApiKeyDialog({
  onClose,
  onIssued,
}: {
  onClose: () => void;
  onIssued: (key: IssuedApiKey) => void;
}) {
  const t = useT();
  const createMut = useCreateApiKey();
  const { data: user } = useCurrentUser();
  const [label, setLabel] = useState("");
  const [canRead, setCanRead] = useState(true);
  const [canTrade, setCanTrade] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const needsTotp = user?.twoFactorEnabled === true;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function submit() {
    setError(null);
    try {
      const trimmed = label.trim();
      const issued = await createMut.mutateAsync({
        label: trimmed === "" ? undefined : trimmed,
        canRead,
        canTrade,
        ...(needsTotp && totpCode !== "" ? { totpCode } : {}),
      });
      onIssued(issued);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === TWO_FACTOR_REQUIRED) {
          setError(t("account.createApiKey.codeRequired"));
          return;
        }
        if (err.code === INVALID_TWO_FACTOR_CODE) {
          setError(t("account.createApiKey.invalidCode"));
          return;
        }
      }
      setError(err instanceof Error ? err.message : t("account.createApiKey.failed"));
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
        aria-label={t("account.createApiKey.title")}
        className="w-full max-w-[380px] bg-surface border border-line"
      >
        <header className="flex items-center justify-between px-4 h-10 border-b border-line">
          <h2 className="text-[13px] font-medium">{t("account.createApiKey.title")}</h2>
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
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-dim">{t("account.createApiKey.labelOptional")}</span>
            <input
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                setError(null);
              }}
              maxLength={MAX_LABEL}
              placeholder={t("account.createApiKey.labelPlaceholder")}
              className="h-9 w-full bg-raised border border-line px-3 text-[13px] text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
            <span className="text-[11px] text-text-muted self-end tnum">
              {label.length}/{MAX_LABEL}
            </span>
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-text-dim">{t("account.createApiKey.permissions")}</span>
            <Toggle
              label={t("account.createApiKey.read")}
              hint={t("account.createApiKey.readHint")}
              checked={canRead}
              onChange={setCanRead}
            />
            <Toggle
              label={t("account.createApiKey.enableTrading")}
              hint={t("account.createApiKey.enableTradingHint")}
              checked={canTrade}
              onChange={setCanTrade}
            />
          </div>

          {needsTotp && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-text-dim">{t("account.createApiKey.twoFactorCode")}</span>
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
                className="h-9 w-full bg-raised border border-line px-3 text-[13px] text-text tnum placeholder:text-text-muted focus:outline-none focus:border-accent"
              />
              <span className="text-[11px] text-text-muted">
                {t("account.createApiKey.twoFactorHint")}
              </span>
            </label>
          )}

          {error && <p className="text-[11px] text-down">{error}</p>}

          <Button
            variant="primary"
            onClick={submit}
            disabled={createMut.isPending}
            className="w-full"
          >
            {createMut.isPending
              ? t("account.createApiKey.creating")
              : t("account.createApiKey.submit")}
          </Button>
        </div>
      </div>
    </div>
  );
}
