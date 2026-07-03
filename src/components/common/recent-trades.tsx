"use client";

import type { Ticker24h, WsTrade } from "@/lib/types/market";
import { formatTime } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";

export function RecentTradesPanel({
  trades,
  ticker,
}: {
  trades: WsTrade[] | null;
  ticker: Ticker24h | null;
}) {
  const t = useT();
  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="flex items-center border-b border-line h-9 px-3 shrink-0">
        <span className="text-[13px] font-medium">{t("widgets.recentTrades.title")}</span>
      </div>
      <div className="grid grid-cols-3 px-3 py-1 text-[11px] text-text-dim border-b border-line shrink-0">
        <span>{t("widgets.orderBook.priceWithUnit", { unit: ticker?.quoteAsset ?? "—" })}</span>
        <span className="text-right">{t("widgets.orderBook.qtyWithUnit", { unit: ticker?.baseAsset ?? "—" })}</span>
        <span className="text-right">{t("common.time")}</span>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {(trades ?? []).map((t) => (
          <div
            key={t.id}
            className="grid grid-cols-3 px-3 h-[22px] items-center text-[12px] tnum hover:bg-raised/50"
          >
            <span className={t.side === "BUY" ? "text-up" : "text-down"}>
              {t.price}
            </span>
            <span className="text-right text-text">{t.qty}</span>
            <span className="text-right text-text-dim">{formatTime(t.ts)}</span>
          </div>
        ))}
        {trades !== null && trades.length === 0 && (
          <div className="p-6 text-center text-[11px] text-text-muted">
            {t("widgets.recentTrades.empty")}
          </div>
        )}
        {trades === null &&
          Array.from({ length: 20 }).map((_, i) => (
            <div
              key={`empty-${i}`}
              className="grid grid-cols-3 px-3 h-[22px] items-center text-[12px] tnum text-text-muted"
            >
              <span>—</span>
              <span className="text-right">—</span>
              <span className="text-right">—</span>
            </div>
          ))}
      </div>
    </div>
  );
}
