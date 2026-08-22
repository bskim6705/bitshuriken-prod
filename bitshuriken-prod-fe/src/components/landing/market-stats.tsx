"use client";

import { useMemo } from "react";
import { useAllTickers } from "@/lib/hooks/use-market";
import { formatInt, formatPct } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";

function num(v: string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatShort(value: number): string {
  if (value === 0) return "$ 0";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$ ${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$ ${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$ ${(value / 1e3).toFixed(2)}K`;
  return `$ ${value.toFixed(2)}`;
}

type Stat = { labelKey: string; value: string; note?: string; tone?: "up" | "down" };

const STAT_LABEL_KEYS = [
  "landing.stats.volume24h",
  "landing.stats.activePairs",
  "landing.stats.trades24h",
  "landing.stats.advancing",
  "landing.stats.declining",
  "landing.stats.topGainer",
] as const;

/** Live exchange KPIs derived from the all-tickers stream (no placeholders). */
export function MarketStats() {
  const t = useT();
  const tickers = useAllTickers();

  const stats = useMemo<Stat[] | null>(() => {
    if (!tickers) return null;
    const volume = tickers.reduce((acc, t) => acc + num(t.quoteVolume24h), 0);
    const trades = tickers.reduce((acc, t) => acc + (t.tradeCount24h ?? 0), 0);
    const withChange = tickers.filter((t) => t.priceChangePct24h !== null);
    const advancing = withChange.filter((t) => num(t.priceChangePct24h) > 0).length;
    const declining = withChange.filter((t) => num(t.priceChangePct24h) < 0).length;
    const topGainer = [...withChange]
      .filter((t) => num(t.priceChangePct24h) > 0)
      .sort((a, b) => num(b.priceChangePct24h) - num(a.priceChangePct24h))[0];

    return [
      { labelKey: "landing.stats.volume24h", value: formatShort(volume) },
      { labelKey: "landing.stats.activePairs", value: formatInt(tickers.length) },
      { labelKey: "landing.stats.trades24h", value: formatInt(trades) },
      { labelKey: "landing.stats.advancing", value: formatInt(advancing), tone: "up" },
      { labelKey: "landing.stats.declining", value: formatInt(declining), tone: "down" },
      topGainer
        ? {
            labelKey: "landing.stats.topGainer",
            value: topGainer.baseAsset,
            note: formatPct(topGainer.priceChangePct24h, { signed: true }),
            tone: "up" as const,
          }
        : { labelKey: "landing.stats.topGainer", value: "—" },
    ];
  }, [tickers]);

  const rows: Stat[] =
    stats ?? STAT_LABEL_KEYS.map((labelKey) => ({ labelKey, value: "—" }));

  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-x-6 gap-y-3">
      {rows.map((s) => {
        const toneCls =
          s.tone === "up" ? "text-up" : s.tone === "down" ? "text-down" : "text-text";
        return (
          <div key={s.labelKey}>
            <p className="text-[11px] text-text-dim">{t(s.labelKey)}</p>
            <p className={`text-[20px] font-semibold tnum leading-tight mt-0.5 ${toneCls}`}>
              {s.value}
            </p>
            {s.note && <p className={`text-[10px] tnum mt-0.5 ${toneCls}`}>{s.note}</p>}
          </div>
        );
      })}
    </div>
  );
}
