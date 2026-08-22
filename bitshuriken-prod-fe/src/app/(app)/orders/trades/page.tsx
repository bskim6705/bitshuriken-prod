"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { fetchMyTrades } from "@/lib/api/account";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useAllTickers } from "@/lib/hooks/use-market";
import { useMyTrades, useUserStream } from "@/lib/hooks/use-trading";
import type { MyTrade } from "@/lib/types/trading";
import type { Ticker24h } from "@/lib/types/market";
import { useT } from "@/lib/i18n/provider";

const TABS = [
  { href: "/orders", labelKey: "orders.tab.open", active: false },
  { href: "/orders/history", labelKey: "orders.tab.history", active: false },
  { href: "/orders/trades", labelKey: "orders.tab.trades", active: true },
];

const COLS = [
  "common.date",
  "orders.col.pair",
  "common.side",
  "orders.col.role",
  "common.price",
  "orders.col.qty",
  "common.fee",
];

const ALL = "ALL";
const PAGE_SIZE = 100;

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

function pairLabel(symbol: string, ticker: Ticker24h | undefined): string {
  return ticker ? `${ticker.baseAsset}/${ticker.quoteAsset}` : symbol;
}

// self-trade는 같은 id로 maker/taker 두 행이 내려오므로 isMaker까지 포함해 식별
function tradeKey(t: MyTrade): string {
  return `${t.id}:${t.isMaker}`;
}

export default function TradeHistoryPage() {
  const t = useT();
  useUserStream();
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const tickers = useAllTickers();
  const [symbol, setSymbol] = useState<string>(ALL);
  // 첫 페이지는 useMyTrades(라이브 invalidate), 과거 페이지는 endTime 커서로 append
  const [olderPages, setOlderPages] = useState<MyTrade[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const symbolParam = symbol === ALL ? undefined : symbol;
  const { data: firstPage, isLoading } = useMyTrades({ symbol: symbolParam, limit: PAGE_SIZE });

  const spotSymbols = useMemo(
    () => (tickers ?? []).filter((t) => t.marketType === "SPOT").map((t) => t.symbol),
    [tickers],
  );
  const tickerMap = useMemo(() => {
    const map = new Map<string, Ticker24h>();
    for (const t of tickers ?? []) if (t.marketType === "SPOT") map.set(t.symbol, t);
    return map;
  }, [tickers]);

  // 첫 페이지 + 과거 페이지 결합 (커서 경계 중복은 id:isMaker로 제거)
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: MyTrade[] = [];
    for (const t of [...(firstPage ?? []), ...olderPages]) {
      const key = tradeKey(t);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out.sort((a, b) => b.time - a.time);
  }, [firstPage, olderPages]);

  const onSymbolChange = (value: string) => {
    setSymbol(value);
    setOlderPages([]);
    setExhausted(false);
    setError(null);
  };

  const reachedEnd =
    exhausted || (olderPages.length === 0 && (firstPage?.length ?? 0) < PAGE_SIZE);

  const loadMore = async () => {
    const oldest = rows[rows.length - 1];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchMyTrades({
        symbol: symbolParam,
        limit: PAGE_SIZE,
        endTime: oldest.time,
      });
      // 커서가 inclusive(lte)라 경계 중복 가능 — 새 행이 없으면 끝으로 간주
      const existing = new Set(rows.map(tradeKey));
      const fresh = page.filter((t) => !existing.has(tradeKey(t)));
      setOlderPages((prev) => [...prev, ...fresh]);
      if (fresh.length === 0 || page.length < PAGE_SIZE) setExhausted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.loadMoreFailed"));
    } finally {
      setLoadingMore(false);
    }
  };

  const signedOut = !authLoading && user == null;
  const loading = authLoading || (user != null && isLoading);

  return (
    <div className="px-3 py-3 w-full">
      <h1 className="text-[15px] font-semibold mb-2">{t("orders.title")}</h1>

      <div className="flex items-center border-b border-line">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`h-8 px-3 inline-flex items-center text-[12px] border-b-2 -mb-px whitespace-nowrap ${
              tab.active
                ? "text-text font-medium border-accent"
                : "text-text-dim hover:text-text border-transparent"
            }`}
          >
            {t(tab.labelKey)}
          </Link>
        ))}
      </div>

      <div className="flex items-center gap-2 py-2">
        <select
          value={symbol}
          onChange={(e) => onSymbolChange(e.target.value)}
          className="h-7 bg-surface border border-line px-2 text-[11px]"
        >
          <option value={ALL}>{t("orders.filter.allPairs")}</option>
          {spotSymbols.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="mb-2 px-2 py-1.5 text-[11px] text-down bg-down-soft border border-down/40">
          {error}
        </p>
      )}

      <div className="bg-surface border border-line">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[11px] text-text-dim border-b border-line">
                {COLS.map((c, i) => (
                  <th
                    key={i}
                    className={`font-normal px-3 py-1.5 whitespace-nowrap ${
                      i < 2 ? "text-left" : "text-right"
                    }`}
                  >
                    {t(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {signedOut && (
                <tr>
                  <td colSpan={COLS.length} className="px-3 py-12 text-center text-[11px] text-text-muted">
                    <Link href="/login" className="text-accent hover:underline">
                      {t("orders.logIn")}
                    </Link>{" "}
                    {t("orders.empty.tradesSignedOut")}
                  </td>
                </tr>
              )}
              {!signedOut && loading && (
                <tr>
                  <td colSpan={COLS.length} className="px-3 py-12 text-center text-[11px] text-text-muted">
                    {t("common.loading")}
                  </td>
                </tr>
              )}
              {!signedOut && !loading && rows.length === 0 && (
                <tr>
                  <td colSpan={COLS.length} className="px-3 py-12 text-center text-[11px] text-text-muted">
                    {t("orders.empty.trades")}
                  </td>
                </tr>
              )}
              {!signedOut &&
                !loading &&
                rows.map((row) => (
                  <tr key={tradeKey(row)} className="border-b border-line last:border-b-0 hover:bg-raised">
                    <td className="px-3 py-2 tnum text-text-dim whitespace-nowrap">
                      {formatDateTime(row.time)}
                    </td>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">
                      {pairLabel(row.symbol, tickerMap.get(row.symbol))}
                    </td>
                    <td
                      className={`px-3 py-2 text-right ${row.isBuyer ? "text-up" : "text-down"}`}
                    >
                      {row.isBuyer ? t("common.buy") : t("common.sell")}
                    </td>
                    <td className="px-3 py-2 text-right text-text-dim">
                      {row.isMaker ? t("orders.role.maker") : t("orders.role.taker")}
                    </td>
                    <td className="px-3 py-2 text-right tnum">{row.price}</td>
                    <td className="px-3 py-2 text-right tnum">{row.qty}</td>
                    <td className="px-3 py-2 text-right tnum text-text-dim whitespace-nowrap">
                      {row.commissionAsset
                        ? `${row.commission} ${row.commissionAsset}`
                        : row.commission}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!signedOut && !loading && rows.length > 0 && !reachedEnd && (
          <div className="border-t border-line py-2 text-center">
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="h-7 px-3 text-[11px] text-accent hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loadingMore ? t("common.loading") : t("orders.loadMore")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
