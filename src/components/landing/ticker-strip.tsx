"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAllTickers } from "@/lib/hooks/use-market";
import { formatPct, formatPrice, priceTone } from "@/lib/format";
import { CoinIcon } from "@/components/common/coin-icon";
import { useT } from "@/lib/i18n/provider";

function num(v: string | null): number {
  if (v === null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Live single-row market ticker — top pairs by 24h volume, updates in place via WS. */
export function TickerStrip() {
  const t = useT();
  const tickers = useAllTickers();
  const top = useMemo(() => {
    if (!tickers) return [];
    return [...tickers]
      .sort((a, b) => num(b.quoteVolume24h) - num(a.quoteVolume24h))
      .slice(0, 16);
  }, [tickers]);

  return (
    <div className="h-9 border-b border-line bg-surface overflow-x-auto">
      <div className="h-full flex items-center whitespace-nowrap">
        {top.length === 0 ? (
          <span className="px-3 text-[11px] text-text-muted">
            {t("landing.ticker.connecting")}
          </span>
        ) : (
          top.map((ticker) => {
            const tone = priceTone(ticker.priceChangePct24h);
            const toneCls =
              tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text-dim";
            return (
              <Link
                key={`${ticker.marketType}:${ticker.symbol}`}
                href={`/trade/${ticker.symbol}`}
                className="px-3 h-full flex items-center gap-2 text-[12px] border-r border-line hover:bg-raised shrink-0"
              >
                <CoinIcon asset={ticker.baseAsset} size={16} />
                <span className="font-medium">{ticker.baseAsset}</span>
                <span className="tnum text-text-dim">{formatPrice(ticker.lastPrice)}</span>
                <span className={`tnum ${toneCls}`}>
                  {formatPct(ticker.priceChangePct24h, { signed: true })}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
