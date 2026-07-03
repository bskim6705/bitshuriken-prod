"use client";

import Link from "next/link";
import type { Ticker24h } from "@/lib/types/market";
import { formatPct, formatPrice, priceTone } from "@/lib/format";
import { CoinIcon } from "@/components/common/coin-icon";
import { useT } from "@/lib/i18n/provider";

const COLS = [
  { key: "sym", labelKey: "markets.col.pair", align: "left" as const },
  { key: "last", labelKey: "markets.col.lastPrice", align: "right" as const },
  { key: "chg", labelKey: "markets.col.change24h", align: "right" as const },
  { key: "high", labelKey: "markets.col.high24h", align: "right" as const },
  { key: "low", labelKey: "markets.col.low24h", align: "right" as const },
  { key: "vol", labelKey: "markets.col.volume24h", align: "right" as const },
  { key: "volq", labelKey: "markets.col.quoteVolume24h", align: "right" as const },
  { key: "act", labelKey: "", align: "right" as const },
];

export function MarketTable({
  tickers,
  loading = false,
}: {
  tickers: Ticker24h[];
  loading?: boolean;
}) {
  const t = useT();
  return (
    <div className="bg-surface border border-line">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[11px] text-text-dim border-b border-line">
              {COLS.map((c) => (
                <th
                  key={c.key}
                  className={`font-normal px-3 py-1.5 ${
                    c.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {c.labelKey ? t(c.labelKey) : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tickers.length === 0 && (
              <tr>
                <td
                  colSpan={COLS.length}
                  className="px-3 py-16 text-center text-[11px] text-text-muted"
                >
                  {loading ? t("common.loading") : t("markets.noResults")}
                </td>
              </tr>
            )}
            {tickers.map((row) => {
              const tone = priceTone(row.priceChangePct24h);
              const toneCls =
                tone === "up"
                  ? "text-up"
                  : tone === "down"
                  ? "text-down"
                  : "text-text-dim";
              return (
                <tr
                  key={`${row.marketType}:${row.symbol}`}
                  className="border-b border-line last:border-b-0 hover:bg-raised"
                >
                  <td className="px-3 py-1.5">
                    <Link
                      href={`/trade/${row.symbol}`}
                      className="flex items-center gap-2 hover:text-accent"
                    >
                      <CoinIcon asset={row.baseAsset} size={16} />
                      <span className="font-medium">{row.baseAsset}</span>
                      <span className="text-text-muted">/{row.quoteAsset}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-1.5 text-right tnum">{formatPrice(row.lastPrice)}</td>
                  <td className={`px-3 py-1.5 text-right tnum ${toneCls}`}>
                    {formatPct(row.priceChangePct24h, { signed: true })}
                  </td>
                  <td className="px-3 py-1.5 text-right tnum text-text-dim">
                    {formatPrice(row.high24h)}
                  </td>
                  <td className="px-3 py-1.5 text-right tnum text-text-dim">
                    {formatPrice(row.low24h)}
                  </td>
                  <td className="px-3 py-1.5 text-right tnum text-text-dim">
                    {row.volume24h}
                  </td>
                  <td className="px-3 py-1.5 text-right tnum text-text-dim">
                    {row.quoteVolume24h}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Link
                      href={`/trade/${row.symbol}`}
                      className="text-[11px] text-accent hover:underline"
                    >
                      {t("markets.trade")}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
