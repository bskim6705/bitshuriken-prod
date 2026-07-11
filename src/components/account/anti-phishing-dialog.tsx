"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useSetAntiPhishing } from "@/lib/hooks/use-security";
import { useT } from "@/lib/i18n/provider";

const MAX_CODE = 32;
const TWO_FACTOR_REQUIRED = 60010;
const INVALID_TWO_FACTOR_CODE = 60011;

export function AntiPhishingDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { data: user } = useCurrentUser();
  const setMut = useSetAntiPhishing();
  const [code, setCode] = useState(user?.antiPhishingCode ?? "");
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
    const trimmed = code.trim();
    try {
      await setMut.mutateAsync({
        code: trimmed === "" ? null : trimmed,
        ...(needsTotp && totpCode !== "" ? { totpCode } : {}),
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === INVALID_TWO_FACTOR_CODE) {
        setError(t("account.antiPhishing.invalidCode"));
      } else if (err instanceof ApiError && err.code === TWO_FACTOR_REQUIRED) {
        setError(t("account.antiPhishing.codeRequired"));
      } else {
        setError(err instanceof Error ? err.message : t("account.antiPhishing.failed"));
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
        aria-label={t("account.antiPhishing.title")}
        className="w-full max-w-[380px] bg-surface border border-line"
      >
        <header className="flex items-center justify-between px-4 h-10 border-b border-line">
          <h2 className="text-[13px] font-medium">{t("account.antiPhishing.title")}</h2>
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
          <p className="text-[11px] text-text-dim">{t("account.antiPhishing.description")}</p>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-dim">{t("account.antiPhishing.codeLabel")}</span>
            <input
              value={code}
              onChange={(e) => {
                setCode(e.target.value.slice(0, MAX_CODE));
                setError(null);
              }}
              maxLength={MAX_CODE}
              placeholder={t("account.antiPhishing.codePlaceholder")}
              className="h-9 w-full bg-raised border border-line px-3 text-[13px] text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
            <span className="text-[11px] text-text-muted self-end tnum">
              {code.length}/{MAX_CODE}
            </span>
          </label>

          {needsTotp && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-text-dim">
                {t("account.antiPhishing.twoFactorCode")}
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
                className="h-9 w-full bg-raised border border-line px-3 text-[13px] text-text tnum placeholder:text-text-muted focus:outline-none focus:border-accent"
              />
            </label>
          )}

          {error && <p className="text-[11px] text-down">{error}</p>}

          <Button
            variant="primary"
            onClick={submit}
            disabled={setMut.isPending || (needsTotp && totpCode.length !== 6)}
            className="w-full"
          >
            {setMut.isPending ? t("account.antiPhishing.saving") : t("account.antiPhishing.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
