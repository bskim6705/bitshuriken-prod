"use client";

import { useState } from "react";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useAdminTickers, useSetTickerStatus } from "@/lib/hooks/use-admin";
import { useT } from "@/lib/i18n/provider";
import type { AdminTicker, TickerStatus } from "@/lib/types/admin";

const STATUSES: TickerStatus[] = ["PENDING", "TRADING", "HALTED", "DELISTED"];
const COL_KEYS = [
  "admin.markets.col.symbol",
  "admin.markets.col.market",
  "admin.markets.col.pair",
  "admin.markets.col.status",
  "admin.markets.col.priceQtyPrec",
  "admin.markets.col.minNotional",
  "admin.markets.col.partition",
  "admin.markets.col.changeStatus",
];

const STATUS_CLS: Record<TickerStatus, string> = {
  TRADING: "text-up",
  PENDING: "text-text-dim",
  HALTED: "text-accent",
  DELISTED: "text-down",
};

function StatusControl({ ticker }: { ticker: AdminTicker }) {
  const t = useT();
  const { data: admin } = useCurrentUser();
  const setStatus = useSetTickerStatus();
  const [next, setNext] = useState<TickerStatus>(ticker.status);
  const [totp, setTotp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsTotp = admin?.twoFactorEnabled === true;
  const changed = next !== ticker.status;

  async function apply() {
    setError(null);
    try {
      await setStatus.mutateAsync({
        market: ticker.marketType,
        symbol: ticker.symbol,
        status: next,
        ...(needsTotp && totp ? { totpCode: totp } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.markets.statusChangeError"));
    }
  }

  return (
    <div className="flex items-center justify-end gap-1.5 flex-wrap">
      <select
        value={next}
        onChange={(e) => setNext(e.target.value as TickerStatus)}
        className="h-7 bg-raised border border-line px-1.5 text-[11px] focus:outline-none focus:border-accent"
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {changed && needsTotp && (
        <input
          value={totp}
          onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="2FA"
          className="w-14 h-7 bg-raised border border-line px-1 text-[11px] tnum focus:outline-none focus:border-accent"
        />
      )}
      <button
        type="button"
        onClick={apply}
        disabled={!changed || setStatus.isPending}
        className="h-7 px-2 text-[11px] border border-line text-accent hover:bg-raised disabled:opacity-40"
      >
        {setStatus.isPending ? "…" : t("admin.markets.apply")}
      </button>
      {error && <span className="text-[10px] text-down w-full text-right">{error}</span>}
    </div>
  );
}

export default function AdminMarketsPage() {
  const t = useT();
  const { data: tickers, isLoading, error } = useAdminTickers();

  return (
    <div>
      <div className="mb-2">
        <h2 className="text-[13px] font-medium">{t("admin.nav.markets")}</h2>
        <p className="text-[11px] text-text-dim mt-0.5">
          {t("admin.markets.desc")}
        </p>
      </div>

      <div className="bg-surface border border-line overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[11px] text-text-dim border-b border-line">
              {COL_KEYS.map((c, i) => (
                <th
                  key={i}
                  className={`font-normal px-3 py-1.5 ${i === 0 ? "text-left" : "text-right"}`}
                >
                  {t(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={COL_KEYS.length} className="px-3 py-12 text-center text-[11px] text-text-muted">
                  {t("common.loading")}
                </td>
              </tr>
            )}
            {!isLoading && error && (
              <tr>
                <td colSpan={COL_KEYS.length} className="px-3 py-12 text-center text-[11px] text-down">
                  {error instanceof Error ? error.message : t("admin.markets.loadError")}
                </td>
              </tr>
            )}
            {!isLoading && !error && (tickers?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={COL_KEYS.length} className="px-3 py-12 text-center text-[11px] text-text-muted">
                  {t("admin.markets.noTickers")}
                </td>
              </tr>
            )}
            {!isLoading &&
              !error &&
              tickers?.map((t) => (
                <tr key={`${t.marketType}-${t.symbol}`} className="border-b border-line last:border-b-0 hover:bg-raised">
                  <td className="px-3 py-2 text-left">{t.symbol}</td>
                  <td className="px-3 py-2 text-right text-text-dim">{t.marketType}</td>
                  <td className="px-3 py-2 text-right text-text-dim">
                    {t.baseAsset}/{t.quoteAsset}
                  </td>
                  <td className={`px-3 py-2 text-right ${STATUS_CLS[t.status]}`}>{t.status}</td>
                  <td className="px-3 py-2 text-right tnum text-text-dim">
                    {t.pricePrecision}/{t.qtyPrecision}
                  </td>
                  <td className="px-3 py-2 text-right tnum text-text-dim">{t.minNotional}</td>
                  <td className="px-3 py-2 text-right tnum text-text-dim">{t.partition}</td>
                  <td className="px-3 py-2 text-right">
                    <StatusControl ticker={t} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
