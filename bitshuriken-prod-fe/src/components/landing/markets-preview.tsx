"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { MarketTable } from "@/components/markets/market-table";
import { useAllTickers } from "@/lib/hooks/use-market";
import { useT } from "@/lib/i18n/provider";
import type { Ticker24h } from "@/lib/types/market";

type TabKey = "volume" | "gainers" | "losers";

const TABS: { key: TabKey; labelKey: string }[] = [
  { key: "volume", labelKey: "landing.markets.tabVolume" },
  { key: "gainers", labelKey: "landing.markets.tabGainers" },
  { key: "losers", labelKey: "landing.markets.tabLosers" },
];

const PREVIEW_LIMIT = 10;

function num(v: string | null): number {
  if (v === null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sortFor(tickers: Ticker24h[], tab: TabKey): Ticker24h[] {
  const list = [...tickers];
  if (tab === "gainers") {
    return list
      .filter((t) => num(t.priceChangePct24h) > 0)
      .sort((a, b) => num(b.priceChangePct24h) - num(a.priceChangePct24h));
  }
  if (tab === "losers") {
    return list
      .filter((t) => num(t.priceChangePct24h) < 0)
      .sort((a, b) => num(a.priceChangePct24h) - num(b.priceChangePct24h));
  }
  return list.sort((a, b) => num(b.quoteVolume24h) - num(a.quoteVolume24h));
}

/** Live markets table for the landing — real ticker data, replaces the old static roster. */
export function MarketsPreview() {
  const t = useT();
  const tickers = useAllTickers();
  const [tab, setTab] = useState<TabKey>("volume");

  const rows = useMemo(() => {
    if (!tickers) return [] as Ticker24h[];
    return sortFor(tickers, tab).slice(0, PREVIEW_LIMIT);
  }, [tickers, tab]);

  return (
    <div>
      <div className="flex items-end justify-between mb-2">
        <h2 className="text-[13px] font-medium">{t("landing.markets.heading")}</h2>
        <Link href="/markets" className="text-[11px] text-accent hover:underline">
          {tickers
            ? t("landing.markets.allCount", { count: tickers.length })
            : t("landing.markets.all")}
        </Link>
      </div>
      <div className="flex items-center border-b border-line mb-2 overflow-x-auto">
        {TABS.map((tab2) => (
          <button
            key={tab2.key}
            onClick={() => setTab(tab2.key)}
            aria-pressed={tab === tab2.key}
            className={`h-8 px-3 text-[12px] shrink-0 border-b-2 -mb-px whitespace-nowrap ${
              tab === tab2.key
                ? "text-text font-medium border-accent"
                : "text-text-dim hover:text-text border-transparent"
            }`}
          >
            {t(tab2.labelKey)}
          </button>
        ))}
      </div>
      <MarketTable tickers={rows} loading={tickers === null} />
    </div>
  );
}
