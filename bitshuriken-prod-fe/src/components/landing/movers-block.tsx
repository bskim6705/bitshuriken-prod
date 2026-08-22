"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAllTickers } from "@/lib/hooks/use-market";
import { formatPct, formatPrice } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import type { Ticker24h } from "@/lib/types/market";

function num(v: string | null): number {
  if (v === null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function MoversBlock() {
  const t = useT();
  const tickers = useAllTickers();

  const { gainers, losers } = useMemo(() => {
    if (!tickers) return { gainers: [] as Ticker24h[], losers: [] as Ticker24h[] };
    const withChange = tickers.filter((t) => t.priceChangePct24h !== null);
    const g = [...withChange]
      .filter((t) => num(t.priceChangePct24h) > 0)
      .sort((a, b) => num(b.priceChangePct24h) - num(a.priceChangePct24h))
      .slice(0, 4);
    const l = [...withChange]
      .filter((t) => num(t.priceChangePct24h) < 0)
      .sort((a, b) => num(a.priceChangePct24h) - num(b.priceChangePct24h))
      .slice(0, 4);
    return { gainers: g, losers: l };
  }, [tickers]);

  return (
    <>
      {[
        { titleKey: "landing.movers.topGainers", data: gainers, tone: "up" as const },
        { titleKey: "landing.movers.topLosers", data: losers, tone: "down" as const },
      ].map((block) => (
        <div key={block.titleKey}>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[13px] font-medium">{t(block.titleKey)}</h2>
            <Link href="/markets" className="text-[11px] text-text-dim hover:text-text">
              {t("landing.movers.seeAll")}
            </Link>
          </div>
          <div className="bg-bg border border-line">
            {block.data.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-text-muted">—</div>
            )}
            {block.data.map((ticker, i) => (
              <div
                key={ticker.symbol}
                className={`grid grid-cols-[1fr_1fr_auto] items-center px-3 py-2 gap-4 ${
                  i < block.data.length - 1 ? "border-b border-line" : ""
                } hover:bg-raised`}
              >
                <Link
                  href={`/trade/${ticker.symbol}`}
                  className="text-[13px] font-medium hover:text-accent"
                >
                  {ticker.baseAsset}/{ticker.quoteAsset}
                </Link>
                <span className="text-[12px] tnum text-text-dim text-right">
                  {formatPrice(ticker.lastPrice)}
                </span>
                <span
                  className={`text-[13px] tnum text-right min-w-[72px] ${
                    block.tone === "up" ? "text-up" : "text-down"
                  }`}
                >
                  {formatPct(ticker.priceChangePct24h, { signed: true })}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
