"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useAdjustBalance } from "@/lib/hooks/use-admin";
import { useT } from "@/lib/i18n/provider";
import type { Market } from "@/lib/types/admin";

const TWO_FACTOR_REQUIRED = 60010;
const INVALID_TWO_FACTOR_CODE = 60011;

type Direction = "credit" | "debit";

export function BalanceAdjustDialog({
  userId,
  userEmail,
  onClose,
}: {
  userId: string;
  userEmail: string;
  onClose: () => void;
}) {
  const t = useT();
  const { data: admin } = useCurrentUser();
  const adjust = useAdjustBalance(userId);

  const [direction, setDirection] = useState<Direction>("credit");
  const [marketType, setMarketType] = useState<Market>("SPOT");
  const [assetSymbol, setAssetSymbol] = useState("USDT");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const needsTotp = admin?.twoFactorEnabled === true;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function submit() {
    setError(null);
    if (!qty || Number(qty) <= 0) {
      setError(t("admin.balanceAdjust.enterPositiveQty"));
      return;
    }
    try {
      await adjust.mutateAsync({
        direction,
        body: {
          marketType,
          assetSymbol: assetSymbol.trim().toUpperCase(),
          qty: qty.trim(),
          reason: reason.trim() || undefined,
          ...(needsTotp && totpCode ? { totpCode } : {}),
        },
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === TWO_FACTOR_REQUIRED) return setError(t("admin.balanceAdjust.twoFactorRequired"));
        if (err.code === INVALID_TWO_FACTOR_CODE) return setError(t("admin.balanceAdjust.invalidTwoFactor"));
      }
      setError(err instanceof Error ? err.message : t("admin.balanceAdjust.failed"));
    }
  }

  const seg = (d: Direction, label: string) => (
    <button
      type="button"
      onClick={() => setDirection(d)}
      className={`flex-1 h-8 text-[12px] border ${
        direction === d
          ? d === "credit"
            ? "bg-up/15 border-up text-up"
            : "bg-down/15 border-down text-down"
          : "border-line text-text-dim hover:text-text"
      }`}
    >
      {label}
    </button>
  );

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
        aria-label={t("admin.balanceAdjust.aria")}
        className="w-full max-w-[400px] bg-surface border border-line"
      >
        <header className="flex items-center justify-between px-4 h-10 border-b border-line">
          <h2 className="text-[13px] font-medium">{t("admin.balanceAdjust.title")}</h2>
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
          <p className="text-[11px] text-text-dim">
            {t("admin.balanceAdjust.target")} <span className="text-text">{userEmail}</span>
          </p>

          <div className="flex gap-2">
            {seg("credit", t("admin.balanceAdjust.creditSeg"))}
            {seg("debit", t("admin.balanceAdjust.debitSeg"))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-text-dim">{t("admin.balanceAdjust.market")}</span>
              <select
                value={marketType}
                onChange={(e) => setMarketType(e.target.value as Market)}
                className="h-9 bg-raised border border-line px-2 text-[13px] focus:outline-none focus:border-accent"
              >
                <option value="SPOT">SPOT</option>
                <option value="FUTURES">FUTURES</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-text-dim">{t("admin.balanceAdjust.asset")}</span>
              <input
                value={assetSymbol}
                onChange={(e) => setAssetSymbol(e.target.value)}
                placeholder="USDT"
                className="h-9 bg-raised border border-line px-3 text-[13px] uppercase focus:outline-none focus:border-accent"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-dim">{t("admin.balanceAdjust.quantity")}</span>
            <input
              value={qty}
              onChange={(e) => {
                setQty(e.target.value.replace(/[^0-9.]/g, ""));
                setError(null);
              }}
              inputMode="decimal"
              placeholder="0.00000000"
              className="h-9 bg-raised border border-line px-3 text-[13px] tnum focus:outline-none focus:border-accent"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-dim">{t("admin.balanceAdjust.reasonOptional")}</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              placeholder={t("admin.balanceAdjust.reasonPlaceholder")}
              className="h-9 bg-raised border border-line px-3 text-[13px] focus:outline-none focus:border-accent"
            />
          </label>

          {needsTotp && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-text-dim">{t("admin.balanceAdjust.your2faCode")}</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="h-9 bg-raised border border-line px-3 text-[13px] tnum focus:outline-none focus:border-accent"
              />
            </label>
          )}

          {error && <p className="text-[11px] text-down">{error}</p>}

          <Button variant="primary" onClick={submit} disabled={adjust.isPending} className="w-full">
            {adjust.isPending
              ? t("admin.balanceAdjust.submitting")
              : direction === "credit"
                ? t("admin.balanceAdjust.creditBalance")
                : t("admin.balanceAdjust.debitBalance")}
          </Button>
        </div>
      </div>
    </div>
  );
}
