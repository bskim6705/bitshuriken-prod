"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccountHistory } from "@/lib/hooks/use-account-history";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useT } from "@/lib/i18n/provider";
import type { MarketType } from "@/lib/types/market";
import type { UnifiedTx, UnifiedTxType } from "@/lib/types/account-history";

// 표시 라벨은 키로 보관하고 렌더에서 t()로 해석한다 (훅은 모듈 스코프 불가).
const COL_KEYS = [
  "wallet.unified.colTime",
  "wallet.unified.colType",
  "wallet.unified.colAsset",
  "wallet.unified.colAmount",
  "wallet.unified.colMarket",
  "wallet.unified.colDetail",
];
const ALL = "ALL";

const TYPE_FILTERS: { value: string; labelKey: string }[] = [
  { value: ALL, labelKey: "wallet.unified.filterAll" },
  { value: "DEPOSIT", labelKey: "wallet.unified.typeDeposit" },
  { value: "WITHDRAWAL", labelKey: "wallet.unified.typeWithdrawal" },
  { value: "TRANSFER", labelKey: "wallet.unified.typeTransfer" },
  { value: "TRADE", labelKey: "wallet.unified.typeTrade" },
  { value: "REALIZED_PNL", labelKey: "wallet.unified.typeRealizedPnl" },
  { value: "FUNDING_FEE", labelKey: "wallet.unified.typeFundingFee" },
  { value: "COMMISSION", labelKey: "wallet.unified.typeCommission" },
  { value: "LIQUIDATION_FEE", labelKey: "wallet.unified.typeLiquidation" },
];

const TYPE_LABEL_KEY: Record<UnifiedTxType, string> = {
  DEPOSIT: "wallet.unified.typeDeposit",
  WITHDRAWAL: "wallet.unified.typeWithdrawal",
  TRANSFER: "wallet.unified.typeTransfer",
  REALIZED_PNL: "wallet.unified.typeRealizedPnl",
  COMMISSION: "wallet.unified.typeCommission",
  FUNDING_FEE: "wallet.unified.typeFundingFee",
  LIQUIDATION_FEE: "wallet.unified.typeLiquidation",
  INSURANCE_CLEAR: "wallet.unified.typeInsurance",
  TRADE: "wallet.unified.typeTrade",
};

const MARKET_LABEL_KEY: Record<MarketType, string> = {
  SPOT: "wallet.market.spot",
  FUTURES: "wallet.market.futures",
};

const NEUTRAL_BADGE = "border-line-strong text-text-dim";

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

type Translate = ReturnType<typeof useT>;

function marketLabel(t: Translate, m: MarketType | null): string {
  return m ? t(MARKET_LABEL_KEY[m]) : "—";
}

/** "0.10000000" → "0.1", "-50.00000000" → "-50" (fixed-8 trailing zero trim) */
function trimQty(v: string): string {
  if (!v.includes(".")) return v;
  return v.replace(/\.?0+$/, "");
}

function amountSign(amount: string): 1 | -1 | 0 {
  const n = Number(amount);
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

/** TRANSFER/TRADE는 중립, 그 외는 부호로 inflow(up)/outflow(down). */
function badgeClass(tx: UnifiedTx): string {
  if (tx.type === "TRANSFER" || tx.type === "TRADE") return NEUTRAL_BADGE;
  const sign = amountSign(tx.amount);
  if (sign > 0) return "border-up/40 text-up";
  if (sign < 0) return "border-down/40 text-down";
  return NEUTRAL_BADGE;
}

function amountClass(tx: UnifiedTx): string {
  const sign = amountSign(tx.amount);
  if (sign > 0) return "text-up";
  if (sign < 0) return "text-down";
  return "text-text";
}

function signedAmount(amount: string): string {
  const trimmed = trimQty(amount);
  return Number(amount) > 0 ? `+${trimmed}` : trimmed;
}

function detailStr(d: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = d[k];
    if (v != null) return String(v);
  }
  return undefined;
}

/** type별 detail 요약. e.g. TRADE "BUY 0.5 @ 50000", TRANSFER "Spot → Futures". */
function detailSummary(t: Translate, tx: UnifiedTx): string {
  const d = tx.detail;
  switch (tx.type) {
    case "TRADE": {
      const side = detailStr(d, "side");
      const qty = tx.amount.replace(/^-/, ""); // base qty는 top-level amount (signed)
      const price = detailStr(d, "price");
      const parts: string[] = [];
      if (side) parts.push(side.toUpperCase());
      if (qty) parts.push(trimQty(qty));
      if (price) parts.push(`@ ${trimQty(price)}`);
      const sym = detailStr(d, "symbol", "market");
      const head = parts.join(" ");
      return sym && head ? `${head} ${sym}` : head || sym || "—";
    }
    case "TRANSFER": {
      const from = detailStr(d, "fromMarket", "from");
      const to = detailStr(d, "toMarket", "to");
      if (from && to)
        return `${marketLabel(t, from as MarketType)} → ${marketLabel(t, to as MarketType)}`;
      return "—";
    }
    case "DEPOSIT":
    case "WITHDRAWAL": {
      return detailStr(d, "status", "network", "address") ?? "—";
    }
    case "FUNDING_FEE": {
      const sym = detailStr(d, "tickerSymbol", "symbol", "market");
      const rate = detailStr(d, "fundingRate", "rate");
      if (sym && rate) return `${sym} ${rate}`;
      return sym ?? "—";
    }
    case "REALIZED_PNL":
    case "COMMISSION":
    case "LIQUIDATION_FEE": {
      return detailStr(d, "tickerSymbol", "symbol", "market") ?? "—";
    }
    default:
      return "—";
  }
}

export function UnifiedHistoryTable() {
  const t = useT();
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const [type, setType] = useState<string>(ALL);

  const typeParam = type === ALL ? undefined : (type as UnifiedTxType);
  const { data, isLoading, isError } = useAccountHistory({ type: typeParam });

  const signedOut = !authLoading && user == null;
  const loading = authLoading || (user != null && isLoading);
  const rows = data ?? [];

  return (
    <div>
      <div className="flex items-center gap-1 py-2 flex-wrap">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setType(f.value)}
            className={`h-7 px-2.5 text-[11px] border ${
              f.value === type
                ? "border-accent text-accent"
                : "border-line text-text-dim hover:text-text"
            }`}
          >
            {t(f.labelKey)}
          </button>
        ))}
      </div>

      <div className="bg-surface border border-line">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[11px] text-text-dim border-b border-line">
                {COL_KEYS.map((c, i) => (
                  <th
                    key={c}
                    className={`font-normal px-3 py-1.5 whitespace-nowrap ${
                      i === 3 ? "text-right" : "text-left"
                    }`}
                  >
                    {t(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {signedOut && (
                <tr>
                  <td
                    colSpan={COL_KEYS.length}
                    className="px-3 py-12 text-center text-[11px] text-text-muted"
                  >
                    <Link href="/login" className="text-accent hover:underline">
                      {t("wallet.unified.loginPre")}
                    </Link>{" "}
                    {t("wallet.unified.loginSuf")}
                  </td>
                </tr>
              )}
              {!signedOut && loading && (
                <tr>
                  <td
                    colSpan={COL_KEYS.length}
                    className="px-3 py-12 text-center text-[11px] text-text-muted"
                  >
                    {t("common.loading")}
                  </td>
                </tr>
              )}
              {!signedOut && !loading && isError && (
                <tr>
                  <td
                    colSpan={COL_KEYS.length}
                    className="px-3 py-12 text-center text-[11px] text-down"
                  >
                    {t("wallet.unified.failedLoad")}
                  </td>
                </tr>
              )}
              {!signedOut && !loading && !isError && rows.length === 0 && (
                <tr>
                  <td
                    colSpan={COL_KEYS.length}
                    className="px-3 py-12 text-center text-[11px] text-text-muted"
                  >
                    {t("wallet.unified.noTransactions")}
                  </td>
                </tr>
              )}
              {!signedOut &&
                !loading &&
                !isError &&
                rows.map((tx) => (
                  <tr key={tx.id} className="border-b border-line last:border-b-0 hover:bg-raised">
                    <td className="px-3 py-2 tnum text-text-dim whitespace-nowrap">
                      {formatDateTime(tx.time)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`px-1.5 py-px text-[10px] border align-middle ${badgeClass(tx)}`}
                      >
                        {t(TYPE_LABEL_KEY[tx.type])}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{tx.asset}</td>
                    <td
                      className={`px-3 py-2 text-right tnum whitespace-nowrap ${amountClass(tx)}`}
                    >
                      {signedAmount(tx.amount)}
                    </td>
                    <td className="px-3 py-2 text-text-dim whitespace-nowrap">
                      {marketLabel(t, tx.market)}
                    </td>
                    <td className="px-3 py-2 text-text-dim whitespace-nowrap">
                      {detailSummary(t, tx)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
