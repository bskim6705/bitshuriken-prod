"use client";

import { useMemo, useState } from "react";
import { MarketTable } from "@/components/markets/market-table";
import { useAllTickers } from "@/lib/hooks/use-market";
import { useT } from "@/lib/i18n/provider";
import type { Ticker24h } from "@/lib/types/market";

type TabKey = "all" | "gainers" | "losers" | "volume";

const TABS: { key: TabKey; labelKey: string }[] = [
  { key: "all", labelKey: "markets.tab.all" },
  { key: "gainers", labelKey: "markets.tab.gainers" },
  { key: "losers", labelKey: "markets.tab.losers" },
  { key: "volume", labelKey: "markets.tab.volume" },
];

function numericField(v: string | null): number {
  if (v === null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function applyFilters(tickers: Ticker24h[], tab: TabKey, quote: string | null): Ticker24h[] {
  let list = quote ? tickers.filter((t) => t.quoteAsset === quote) : [...tickers];
  if (tab === "gainers") {
    list = list
      .filter((t) => numericField(t.priceChangePct24h) > 0)
      .sort(
        (a, b) =>
          numericField(b.priceChangePct24h) - numericField(a.priceChangePct24h),
      );
  } else if (tab === "losers") {
    list = list
      .filter((t) => numericField(t.priceChangePct24h) < 0)
      .sort(
        (a, b) =>
          numericField(a.priceChangePct24h) - numericField(b.priceChangePct24h),
      );
  } else if (tab === "volume") {
    list = list.sort(
      (a, b) => numericField(b.quoteVolume24h) - numericField(a.quoteVolume24h),
    );
  }
  return list;
}

export default function MarketsPage() {
  const t = useT();
  const tickers = useAllTickers();
  const [tab, setTab] = useState<TabKey>("all");
  const [quote, setQuote] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const quotes = useMemo(() => {
    if (!tickers) return [] as string[];
    return Array.from(new Set(tickers.map((t) => t.quoteAsset))).sort();
  }, [tickers]);

  const filtered = useMemo(() => {
    if (!tickers) return [] as Ticker24h[];
    let list = applyFilters(tickers, tab, quote);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (t) =>
          t.symbol.toLowerCase().includes(q) ||
          t.baseAsset.toLowerCase().includes(q),
      );
    }
    return list;
  }, [tickers, tab, quote, search]);

  return (
    <div className="px-3 py-3 w-full">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-[15px] font-semibold">{t("markets.title")}</h1>
        <input
          type="search"
          aria-label={t("markets.searchAria")}
          placeholder={t("markets.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 w-56 bg-surface border border-line px-2 text-[12px] placeholder:text-text-muted focus:outline-none focus:border-accent"
        />
      </div>

      <div className="flex items-center border-b border-line overflow-x-auto">
        {TABS.map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={`h-8 px-3 text-[12px] shrink-0 border-b-2 -mb-px whitespace-nowrap ${
              tab === item.key
                ? "text-text font-medium border-accent"
                : "text-text-dim hover:text-text border-transparent"
            }`}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>
      <div className="flex items-center h-8 gap-1 border-b border-line mb-2">
        <button
          onClick={() => setQuote(null)}
          className={`h-6 px-2.5 text-[11px] ${
            quote === null ? "bg-raised text-text" : "text-text-dim hover:text-text"
          }`}
        >
          {t("markets.tab.all")}
        </button>
        {quotes.map((q) => (
          <button
            key={q}
            onClick={() => setQuote(q)}
            className={`h-6 px-2.5 text-[11px] ${
              quote === q ? "bg-raised text-text" : "text-text-dim hover:text-text"
            }`}
          >
            {q}
          </button>
        ))}
      </div>

      <MarketTable tickers={filtered} loading={tickers === null} />
    </div>
  );
}
