"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { IssuedApiKey } from "@/lib/types/api-key";
import { useT } from "@/lib/i18n/provider";

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

function SecretRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-text-dim">{label}</span>
      <div className="flex items-center gap-2 bg-raised border border-line px-3 py-2">
        <span className="flex-1 text-[12px] text-text tnum break-all">{value}</span>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

export function ApiKeySecretDialog({
  issued,
  onClose,
}: {
  issued: IssuedApiKey;
  onClose: () => void;
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("account.apiKeySecret.title")}
        className="w-full max-w-[420px] bg-surface border border-line"
      >
        <header className="flex items-center justify-between px-4 h-10 border-b border-line">
          <h2 className="text-[13px] font-medium">{t("account.apiKeySecret.title")}</h2>
        </header>

        <div className="p-4 flex flex-col gap-3">
          <p className="text-[11px] text-down border border-down/40 bg-down/10 px-3 py-2">
            {t("account.apiKeySecret.warning")}
          </p>

          <SecretRow label={t("account.apiKeySecret.apiKey")} value={issued.apiKey} />
          <SecretRow label={t("account.apiKeySecret.secretKey")} value={issued.secret} />

          <Button variant="primary" onClick={onClose} className="w-full">
            {t("account.apiKeySecret.saved")}
          </Button>
        </div>
      </div>
    </div>
  );
}
