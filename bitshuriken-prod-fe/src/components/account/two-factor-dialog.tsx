"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { useDisable2fa, useEnable2fa, useSetup2fa } from "@/lib/hooks/use-security";
import type { TwoFactorSetup } from "@/lib/api/auth";
import { useT } from "@/lib/i18n/provider";

const INVALID_TWO_FACTOR_CODE = 60011;

function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
        aria-label={title}
        className="w-full max-w-[380px] bg-surface border border-line"
      >
        <header className="flex items-center justify-between px-4 h-10 border-b border-line">
          <h2 className="text-[13px] font-medium">{title}</h2>
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
        <div className="p-4 flex flex-col gap-3">{children}</div>
      </div>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 text-[11px] text-accent hover:underline"
    >
      {copied ? t("common.copied") : t("common.copy")}
    </button>
  );
}

function CodeInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="000000"
      disabled={disabled}
      className="h-9 w-full bg-raised border border-line px-3 text-[13px] text-text tnum tracking-[0.3em] placeholder:text-text-muted focus:outline-none focus:border-accent disabled:opacity-40"
    />
  );
}

function EnableDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const setupMut = useSetup2fa();
  const enableMut = useEnable2fa();
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Kick off enrollment once when the dialog mounts.
  useEffect(() => {
    let active = true;
    setupMut
      .mutateAsync()
      .then((res) => {
        if (active) setSetup(res);
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : t("account.twoFactor.setupFailed"));
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    setError(null);
    try {
      await enableMut.mutateAsync(code);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === INVALID_TWO_FACTOR_CODE) {
        setError(t("account.twoFactor.invalidCode"));
      } else {
        setError(err instanceof Error ? err.message : t("account.twoFactor.enableFailed"));
      }
    }
  }

  return (
    <DialogShell title={t("account.twoFactor.enableTitle")} onClose={onClose}>
      <p className="text-[11px] text-text-dim">
        {t("account.twoFactor.enableIntro")}
      </p>

      {setupMut.isPending && !setup && (
        <p className="text-[11px] text-text-muted text-center py-8">
          {t("account.twoFactor.generating")}
        </p>
      )}

      {setup && (
        <>
          <div className="grid place-items-center bg-raised border border-line p-3">
            {/* QR is a backend-issued data-URL PNG; render directly. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={setup.qrDataUrl}
              alt={t("account.twoFactor.qrAlt")}
              width={160}
              height={160}
              className="w-[160px] h-[160px]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-dim">{t("account.twoFactor.manualKey")}</span>
            <div className="flex items-center gap-2 bg-raised border border-line px-3 py-2">
              <span className="flex-1 text-[12px] text-text tnum break-all">{setup.secret}</span>
              <CopyButton value={setup.secret} />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-dim">{t("account.twoFactor.verificationCode")}</span>
            <CodeInput
              value={code}
              onChange={(next) => {
                setCode(next);
                setError(null);
              }}
              disabled={enableMut.isPending}
            />
          </div>
        </>
      )}

      {error && <p className="text-[11px] text-down">{error}</p>}

      <Button
        variant="primary"
        onClick={submit}
        disabled={!setup || code.length !== 6 || enableMut.isPending}
        className="w-full"
      >
        {enableMut.isPending ? t("account.twoFactor.enabling") : t("common.enable")}
      </Button>
    </DialogShell>
  );
}

function DisableDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const disableMut = useDisable2fa();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await disableMut.mutateAsync(code);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === INVALID_TWO_FACTOR_CODE) {
        setError(t("account.twoFactor.invalidCode"));
      } else {
        setError(err instanceof Error ? err.message : t("account.twoFactor.disableFailed"));
      }
    }
  }

  return (
    <DialogShell title={t("account.twoFactor.disableTitle")} onClose={onClose}>
      <p className="text-[11px] text-text-dim">
        {t("account.twoFactor.disableIntro")}
      </p>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-text-dim">{t("account.twoFactor.verificationCode")}</span>
        <CodeInput
          value={code}
          onChange={(next) => {
            setCode(next);
            setError(null);
          }}
          disabled={disableMut.isPending}
        />
      </div>

      {error && <p className="text-[11px] text-down">{error}</p>}

      <Button
        variant="primary"
        onClick={submit}
        disabled={code.length !== 6 || disableMut.isPending}
        className="w-full"
      >
        {disableMut.isPending ? t("account.twoFactor.disabling") : t("account.twoFactor.disableSubmit")}
      </Button>
    </DialogShell>
  );
}

export function TwoFactorDialog({
  mode,
  onClose,
}: {
  mode: "enable" | "disable";
  onClose: () => void;
}) {
  return mode === "enable" ? (
    <EnableDialog onClose={onClose} />
  ) : (
    <DisableDialog onClose={onClose} />
  );
}
