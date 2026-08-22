"use client";

import { useEffect, useMemo, useState } from "react";
import {
  PairSelectorFrame,
  SymbolHeaderFrame,
  type HeaderStat,
} from "@/components/common/symbol-header";
import {
  useFuturesMarkPrice,
  useFuturesTicker,
  useFuturesTickers,
} from "@/lib/hooks/use-futures-market";
import { formatPct, formatPrice, priceTone } from "@/lib/format";
import { CoinIcon } from "@/components/common/coin-icon";
import { useT } from "@/lib/i18n/provider";

/** 펀딩 비율은 % 표기 4자리 (예: +0.0100%). */
function formatFundingRate(rate: string | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  const n = Number(rate) * 100;
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${Math.abs(n).toFixed(4)}%`;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${p(h)}:${p(m)}:${p(s)}`;
}

function PairSelector({ current, onClose }: { current: string; onClose: () => void }) {
  const t = useT();
  const tickers = useFuturesTickers();
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const list = tickers ?? [];
    if (!search.trim()) return list;
    const q = search.trim().toLowerCase();
    return list.filter(
      (t) => t.symbol.toLowerCase().includes(q) || t.baseAsset.toLowerCase().includes(q),
    );
  }, [tickers, search]);

  return (
    <PairSelectorFrame
      current={current}
      onClose={onClose}
      placeholder={t("futures.header.searchContract")}
      search={search}
      onSearchChange={setSearch}
      loading={tickers === null}
      rows={filtered.map((row) => ({
        symbol: row.symbol,
        lastPrice: row.lastPrice,
        pct: row.priceChangePct24h,
        primary: (
          <span className="flex items-center gap-2">
            <CoinIcon asset={row.baseAsset} size={16} />
            <span>
              <span className="font-medium">{row.symbol}</span>
              <span className="ml-1 text-[10px] text-text-muted">{t("futures.perp")}</span>
            </span>
          </span>
        ),
      }))}
      hrefFor={(s) => `/futures/${s}`}
    />
  );
}

export function FuturesSymbolHeader({ symbol }: { symbol: string }) {
  const t = useT();
  const ticker = useFuturesTicker(symbol);
  const markPrice = useFuturesMarkPrice(symbol);

  // 펀딩 카운트다운 1s tick
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const tone = priceTone(ticker?.priceChangePct24h ?? null);
  const base = ticker?.baseAsset ?? symbol.replace(/USDT$/, "");
  const quote = ticker?.quoteAsset ?? "USDT";

  const countdown =
    markPrice !== null ? formatCountdown(markPrice.nextFundingTime - now) : "—";

  const stats: HeaderStat[] = [
    { label: t("futures.header.mark"), value: formatPrice(markPrice?.markPrice ?? null) },
    { label: t("futures.header.index"), value: formatPrice(markPrice?.indexPrice ?? null) },
    {
      label: t("futures.header.fundingCountdown"),
      value: `${formatFundingRate(markPrice?.lastFundingRate)} / ${countdown}`,
    },
    {
      label: t("futures.header.change24h"),
      value: formatPct(ticker?.priceChangePct24h ?? null, { signed: true }),
      tone,
    },
    { label: t("futures.header.high24h"), value: formatPrice(ticker?.high24h ?? null) },
    { label: t("futures.header.low24h"), value: formatPrice(ticker?.low24h ?? null) },
    { label: t("futures.header.vol24hBase", { asset: base }), value: ticker?.volume24h ?? "—" },
    { label: t("futures.header.vol24hQuote", { asset: quote }), value: ticker?.quoteVolume24h ?? "—" },
  ];

  return (
    <SymbolHeaderFrame
      ticker={ticker}
      title={
        <>
          <span className="text-[14px] font-semibold">{symbol}</span>
          <span className="text-[10px] text-text-dim border border-line px-1">{t("futures.perp")}</span>
        </>
      }
      usdApprox
      stats={stats}
      renderSelector={(onClose) => <PairSelector current={symbol} onClose={onClose} />}
    />
  );
}
