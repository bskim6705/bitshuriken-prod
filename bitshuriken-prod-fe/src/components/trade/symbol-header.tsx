"use client";

import { useMemo, useState } from "react";
import {
  PairSelectorFrame,
  SymbolHeaderFrame,
  type HeaderStat,
} from "@/components/common/symbol-header";
import { useAllTickers, useTicker } from "@/lib/hooks/use-market";
import { formatPct, formatPrice, priceTone } from "@/lib/format";
import { CoinIcon } from "@/components/common/coin-icon";
import { useT } from "@/lib/i18n/provider";

function PairSelector({ current, onClose }: { current: string; onClose: () => void }) {
  const t = useT();
  const tickers = useAllTickers();
  const [search, setSearch] = useState("");
  const [quote, setQuote] = useState<string | null>(null);

  const spot = useMemo(
    () => (tickers ?? []).filter((t) => t.marketType === "SPOT"),
    [tickers],
  );
  const quotes = useMemo(
    () => Array.from(new Set(spot.map((t) => t.quoteAsset))).sort(),
    [spot],
  );
  const filtered = useMemo(() => {
    let list = quote ? spot.filter((t) => t.quoteAsset === quote) : spot;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (t) => t.symbol.toLowerCase().includes(q) || t.baseAsset.toLowerCase().includes(q),
      );
    }
    return list;
  }, [spot, quote, search]);

  return (
    <PairSelectorFrame
      current={current}
      onClose={onClose}
      placeholder={t("trade.header.searchPair")}
      search={search}
      onSearchChange={setSearch}
      filterTabs={
        <div className="flex items-center gap-1 px-2 h-8 border-b border-line overflow-x-auto">
          <button
            onClick={() => setQuote(null)}
            className={`h-6 px-2.5 text-[11px] shrink-0 ${
              quote === null ? "bg-raised text-text" : "text-text-dim hover:text-text"
            }`}
          >
            {t("common.all")}
          </button>
          {quotes.map((q) => (
            <button
              key={q}
              onClick={() => setQuote(q)}
              className={`h-6 px-2.5 text-[11px] shrink-0 ${
                quote === q ? "bg-raised text-text" : "text-text-dim hover:text-text"
              }`}
            >
              {q}
            </button>
          ))}
        </div>
      }
      loading={tickers === null}
      rows={filtered.map((t) => ({
        symbol: t.symbol,
        lastPrice: t.lastPrice,
        pct: t.priceChangePct24h,
        primary: (
          <span className="flex items-center gap-2">
            <CoinIcon asset={t.baseAsset} size={16} />
            <span>
              <span className="font-medium">{t.baseAsset}</span>
              <span className="text-text-muted">/{t.quoteAsset}</span>
            </span>
          </span>
        ),
      }))}
      hrefFor={(s) => `/trade/${s}`}
    />
  );
}

export function SymbolHeader({ symbol }: { symbol: string }) {
  const t = useT();
  const ticker = useTicker(symbol);

  const tone = priceTone(ticker?.priceChangePct24h ?? null);
  const base = ticker?.baseAsset ?? symbol.replace(/USDT$/, "");
  const quote = ticker?.quoteAsset ?? "USDT";
  const usdQuote = ticker?.quoteAsset === "USDT" || ticker?.quoteAsset === "USDC";

  const stats: HeaderStat[] = [
    {
      label: t("trade.header.change24h"),
      value: formatPct(ticker?.priceChangePct24h ?? null, { signed: true }),
      tone,
    },
    { label: t("trade.header.high24h"), value: formatPrice(ticker?.high24h ?? null) },
    { label: t("trade.header.low24h"), value: formatPrice(ticker?.low24h ?? null) },
    { label: t("trade.header.vol24h", { asset: base }), value: ticker?.volume24h ?? "—" },
    { label: t("trade.header.vol24h", { asset: quote }), value: ticker?.quoteVolume24h ?? "—" },
  ];

  return (
    <SymbolHeaderFrame
      ticker={ticker}
      title={
        <span className="text-[14px] font-semibold">
          {base}/{quote}
        </span>
      }
      usdApprox={usdQuote}
      stats={stats}
      renderSelector={(onClose) => <PairSelector current={symbol} onClose={onClose} />}
    />
  );
}
