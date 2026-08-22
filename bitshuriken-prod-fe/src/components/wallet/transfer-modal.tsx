"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { LabeledInput } from "@/components/ui/input";
import { useBalances } from "@/lib/hooks/use-trading";
import { useFuturesBalances, useTransfer } from "@/lib/hooks/use-futures-trading";
import { TRANSACTIONS_KEY } from "@/lib/hooks/use-transactions";
import { useT } from "@/lib/i18n/provider";
import type { MarketType } from "@/lib/types/market";

// 선물 MVP는 USDT-margined — 이체 자산 고정
const ASSET = "USDT";
const NUMERIC_RE = /^\d*\.?\d*$/;

const MARKETS: MarketType[] = ["SPOT", "FUTURES"];
// 표시 라벨은 키로 보관하고 렌더에서 t()로 해석한다 (훅은 모듈 스코프 불가).
const WALLET_LABEL_KEY: Record<MarketType, string> = {
  SPOT: "wallet.transferModal.spotWallet",
  FUTURES: "wallet.transferModal.futuresWallet",
};

function isPos(v: string): boolean {
  return v !== "" && NUMERIC_RE.test(v) && Number(v) > 0;
}

function decimalsOf(v: string): number {
  const i = v.indexOf(".");
  return i === -1 ? 0 : v.length - i - 1;
}

/** 제출 직전 trailing dot 제거 ("5." → "5"). */
function normDecimal(v: string): string {
  return v.endsWith(".") ? v.slice(0, -1) : v;
}

export function TransferModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const spotBalances = useBalances();
  const futuresBalances = useFuturesBalances();
  const transferMut = useTransfer();

  const [fromMarket, setFromMarket] = useState<MarketType>("SPOT");
  const [toMarket, setToMarket] = useState<MarketType>("FUTURES");
  const [qty, setQty] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 자산은 USDT 고정(MVP)
  function availOf(m: MarketType): string | null {
    const list = m === "SPOT" ? spotBalances.data : futuresBalances.data;
    return list?.find((b) => b.asset === ASSET)?.free ?? null;
  }
  const available = availOf(fromMarket);

  function onFromChange(m: MarketType) {
    setFromMarket(m);
    if (m === toMarket) setToMarket(MARKETS.find((x) => x !== m) ?? toMarket);
    setQty("");
    setError(null);
  }
  function onToChange(m: MarketType) {
    setToMarket(m);
    if (m === fromMarket) setFromMarket(MARKETS.find((x) => x !== m) ?? fromMarket);
    setQty("");
    setError(null);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function swap() {
    setFromMarket(toMarket);
    setToMarket(fromMarket);
    setQty("");
    setError(null);
  }

  function handleQty(v: string) {
    if (!NUMERIC_RE.test(v)) return;
    setQty(v);
    setError(null);
  }

  async function submit() {
    if (!isPos(qty)) {
      setError(t("wallet.transferModal.invalidQty"));
      return;
    }
    if (decimalsOf(qty) > 8) {
      setError(t("wallet.transferModal.maxDecimals"));
      return;
    }
    setError(null);
    try {
      await transferMut.mutateAsync({
        fromMarket,
        toMarket,
        assetSymbol: ASSET,
        qty: normDecimal(qty),
      });
      void qc.invalidateQueries({ queryKey: TRANSACTIONS_KEY });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("wallet.transferModal.failed"));
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
        aria-label={t("wallet.transferModal.title")}
        className="w-full max-w-[360px] bg-surface border border-line"
      >
        <header className="flex items-center justify-between px-4 h-10 border-b border-line">
          <h2 className="text-[13px] font-medium">{t("wallet.transferModal.title")}</h2>
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
          <div className="flex items-stretch gap-2">
            <div className="flex-1 flex flex-col gap-1.5">
              <label className="flex items-center h-9 bg-raised border border-line px-3 text-[12px]">
                <span className="text-text-dim w-10 shrink-0">{t("wallet.transferModal.from")}</span>
                <select
                  value={fromMarket}
                  onChange={(e) => onFromChange(e.target.value as MarketType)}
                  className="flex-1 bg-transparent text-text focus:outline-none"
                >
                  {MARKETS.map((m) => (
                    <option key={m} value={m}>
                      {t(WALLET_LABEL_KEY[m])}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center h-9 bg-raised border border-line px-3 text-[12px]">
                <span className="text-text-dim w-10 shrink-0">{t("wallet.transferModal.to")}</span>
                <select
                  value={toMarket}
                  onChange={(e) => onToChange(e.target.value as MarketType)}
                  className="flex-1 bg-transparent text-text focus:outline-none"
                >
                  {MARKETS.map((m) => (
                    <option key={m} value={m}>
                      {t(WALLET_LABEL_KEY[m])}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              type="button"
              aria-label={t("wallet.transferModal.swapDirection")}
              onClick={swap}
              className="w-9 grid place-items-center border border-line text-text-dim hover:text-text hover:bg-raised"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 4v13m0 3-3.5-3.5M8 20l3.5-3.5" />
                <path d="M16 20V7m0-3 3.5 3.5M16 4l-3.5 3.5" />
              </svg>
            </button>
          </div>

          <div className="flex items-center h-9 bg-raised border border-line px-3 text-[12px]">
            <span className="text-text-dim w-10 shrink-0">{t("wallet.transferModal.asset")}</span>
            <span>{ASSET}</span>
          </div>

          <div className="flex flex-col gap-1">
            <LabeledInput
              label={t("wallet.transferModal.qty")}
              suffix={ASSET}
              value={qty}
              onChange={(e) => handleQty(e.target.value)}
              placeholder="0"
              inputMode="decimal"
            />
            <p className="flex items-center justify-between text-[11px]">
              <span className="text-text-dim">
                {t("wallet.transferModal.available")}{" "}
                <span className="text-text tnum">{available ?? "—"}</span>{" "}
                <span className="text-text-muted">{ASSET}</span>
              </span>
              <button
                type="button"
                onClick={() => available !== null && handleQty(available)}
                disabled={available === null}
                className="text-accent hover:underline disabled:text-text-muted disabled:no-underline"
              >
                {t("wallet.transferModal.max")}
              </button>
            </p>
          </div>

          {error && <p className="text-[11px] text-down">{error}</p>}

          <Button
            variant="primary"
            onClick={submit}
            disabled={transferMut.isPending}
            className="w-full"
          >
            {transferMut.isPending ? t("wallet.transferModal.pending") : t("wallet.transferModal.cta")}
          </Button>
        </div>
      </div>
    </div>
  );
}
