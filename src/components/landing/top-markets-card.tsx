"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAllTickers } from "@/lib/hooks/use-market";
import { formatPct, formatPrice, priceTone } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";

export function TopMarketsCard() {
  const t = useT();
  const tickers = useAllTickers();
  const top = useMemo(() => {
    if (!tickers) return [];
    return [...tickers]
      .sort((a, b) => Number(b.quoteVolume24h) - Number(a.quoteVolume24h))
      .slice(0, 6);
  }, [tickers]);

  return (
    <div className="bg-surface border border-line">
      <div className="px-3 h-8 border-b border-line flex items-center justify-between">
        <span className="text-[12px] font-medium">{t("landing.topMarkets.title")}</span>
        <Link href="/markets" className="text-[11px] text-accent hover:underline">
          {t("landing.topMarkets.allMarkets")}
        </Link>
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[11px] text-text-dim border-b border-line">
            <th className="font-normal text-left px-3 py-1.5">{t("landing.topMarkets.colPair")}</th>
            <th className="font-normal text-right px-3 py-1.5">{t("landing.topMarkets.colLast")}</th>
            <th className="font-normal text-right px-3 py-1.5">{t("landing.topMarkets.col24h")}</th>
            <th className="font-normal text-right px-3 py-1.5 hidden sm:table-cell">{t("landing.topMarkets.colVol")}</th>
          </tr>
        </thead>
        <tbody>
          {top.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-10 text-center text-[11px] text-text-muted">
                {t("common.loading")}
              </td>
            </tr>
          )}
          {top.map((m) => {
            const tone = priceTone(m.priceChangePct24h);
            const toneCls =
              tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text-dim";
            return (
              <tr
                key={m.symbol}
                className="border-b border-line last:border-b-0 hover:bg-raised cursor-pointer"
              >
                <td className="px-3 py-1.5">
                  <Link href={`/trade/${m.symbol}`} className="font-medium hover:text-accent">
                    {m.baseAsset}/{m.quoteAsset}
                  </Link>
                </td>
                <td className="px-3 py-1.5 text-right tnum">{formatPrice(m.lastPrice)}</td>
                <td className={`px-3 py-1.5 text-right tnum ${toneCls}`}>
                  {formatPct(m.priceChangePct24h, { signed: true })}
                </td>
                <td className="px-3 py-1.5 text-right tnum text-text-dim hidden sm:table-cell">
                  {m.quoteVolume24h}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
