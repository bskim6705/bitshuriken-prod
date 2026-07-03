"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { fetchOrders } from "@/lib/api/account";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useAllTickers } from "@/lib/hooks/use-market";
import { useOrderHistory, useUserStream } from "@/lib/hooks/use-trading";
import type { Order } from "@/lib/types/trading";
import type { OrderSide, Ticker24h } from "@/lib/types/market";
import { useT } from "@/lib/i18n/provider";

const TABS = [
  { href: "/orders", labelKey: "orders.tab.open", active: false },
  { href: "/orders/history", labelKey: "orders.tab.history", active: true },
  { href: "/orders/trades", labelKey: "orders.tab.trades", active: false },
];

const COLS = [
  "common.date",
  "orders.col.pair",
  "common.type",
  "common.side",
  "common.price",
  "orders.col.qty",
  "orders.col.filled",
  "common.total",
  "common.status",
];

const ALL = "ALL";
const PAGE_SIZE = 100;

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

/** "STOP_LOSS_LIMIT" → "Stop Loss Limit" */
function typeLabel(type: string): string {
  return type
    .split("_")
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(" ");
}

function pairLabel(symbol: string, ticker: Ticker24h | undefined): string {
  return ticker ? `${ticker.baseAsset}/${ticker.quoteAsset}` : symbol;
}

function qtyDisplay(order: Order, ticker: Ticker24h | undefined): string {
  if (order.origQty) return order.origQty;
  if (order.origQuoteQty) {
    return ticker ? `${order.origQuoteQty} ${ticker.quoteAsset}` : order.origQuoteQty;
  }
  return "—";
}

const STATUS_TONE: Record<string, string> = {
  FILLED: "text-up",
  CANCELED: "text-text-dim",
  REJECTED: "text-down",
  EXPIRED: "text-text-dim",
};

export default function OrderHistoryPage() {
  const t = useT();
  useUserStream();
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const tickers = useAllTickers();
  const [symbol, setSymbol] = useState<string>(ALL);
  const [side, setSide] = useState<string>(ALL);
  // 첫 페이지는 useOrderHistory(라이브 invalidate), 과거 페이지는 endTime 커서로 append
  const [olderPages, setOlderPages] = useState<Order[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const symbolParam = symbol === ALL ? undefined : symbol;
  const { data: firstPage, isLoading } = useOrderHistory({ symbol: symbolParam, limit: PAGE_SIZE });

  const spotSymbols = useMemo(
    () => (tickers ?? []).filter((t) => t.marketType === "SPOT").map((t) => t.symbol),
    [tickers],
  );
  const tickerMap = useMemo(() => {
    const map = new Map<string, Ticker24h>();
    for (const t of tickers ?? []) if (t.marketType === "SPOT") map.set(t.symbol, t);
    return map;
  }, [tickers]);

  // 첫 페이지 + 과거 페이지 결합 (커서 경계 중복은 id로 제거)
  const combined = useMemo(() => {
    const seen = new Set<string>();
    const out: Order[] = [];
    for (const o of [...(firstPage ?? []), ...olderPages]) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      out.push(o);
    }
    return out.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [firstPage, olderPages]);

  const rows = useMemo(
    () => combined.filter((o) => side === ALL || o.side === (side as OrderSide)),
    [combined, side],
  );

  const resetPaging = () => {
    setOlderPages([]);
    setExhausted(false);
    setError(null);
  };

  const onSymbolChange = (value: string) => {
    setSymbol(value);
    resetPaging();
  };

  const reachedEnd =
    exhausted || (olderPages.length === 0 && (firstPage?.length ?? 0) < PAGE_SIZE);

  const loadMore = async () => {
    const oldest = combined[combined.length - 1];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchOrders({
        symbol: symbolParam,
        limit: PAGE_SIZE,
        endTime: new Date(oldest.createdAt).getTime(),
      });
      // 커서가 inclusive(lte)라 경계 중복 가능 — 새 행이 없으면 끝으로 간주
      const existing = new Set(combined.map((o) => o.id));
      const fresh = page.filter((o) => !existing.has(o.id));
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
        <select
          value={side}
          onChange={(e) => setSide(e.target.value)}
          className="h-7 bg-surface border border-line px-2 text-[11px]"
        >
          <option value={ALL}>{t("orders.filter.allSides")}</option>
          <option value="BUY">{t("common.buy")}</option>
          <option value="SELL">{t("common.sell")}</option>
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
                    {t("orders.empty.historySignedOut")}
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
                    {t("orders.empty.history")}
                  </td>
                </tr>
              )}
              {!signedOut &&
                !loading &&
                rows.map((o) => {
                  const ticker = tickerMap.get(o.tickerSymbol);
                  return (
                    <tr key={o.id} className="border-b border-line last:border-b-0 hover:bg-raised">
                      <td className="px-3 py-2 tnum text-text-dim whitespace-nowrap">
                        {formatDateTime(o.createdAt)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="font-medium">{pairLabel(o.tickerSymbol, ticker)}</span>
                        {o.orderListId && (
                          <span className="ml-1.5 px-1 py-px text-[10px] border border-accent text-accent align-middle">
                            OCO
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{typeLabel(o.type)}</td>
                      <td
                        className={`px-3 py-2 text-right ${
                          o.side === "BUY" ? "text-up" : "text-down"
                        }`}
                      >
                        {o.side === "BUY" ? t("common.buy") : t("common.sell")}
                      </td>
                      <td className="px-3 py-2 text-right tnum">{o.price ?? t("orders.market")}</td>
                      <td className="px-3 py-2 text-right tnum">{qtyDisplay(o, ticker)}</td>
                      <td className="px-3 py-2 text-right tnum text-text-dim">{o.executedQty}</td>
                      <td className="px-3 py-2 text-right tnum text-text-dim">
                        {o.cumulativeQuoteQty}
                      </td>
                      <td
                        className={`px-3 py-2 text-right ${STATUS_TONE[o.status] ?? "text-text"}`}
                      >
                        {typeLabel(o.status)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        {!signedOut && !loading && combined.length > 0 && !reachedEnd && (
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
