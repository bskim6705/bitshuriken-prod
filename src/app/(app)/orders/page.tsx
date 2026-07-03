"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useAllTickers } from "@/lib/hooks/use-market";
import {
  useCancelAllOrders,
  useCancelOrder,
  useOpenOrders,
  useUserStream,
} from "@/lib/hooks/use-trading";
import type { Order } from "@/lib/types/trading";
import type { OrderSide, Ticker24h } from "@/lib/types/market";
import { useT } from "@/lib/i18n/provider";

const TABS = [
  { href: "/orders", labelKey: "orders.tab.open", active: true },
  { href: "/orders/history", labelKey: "orders.tab.history", active: false },
  { href: "/orders/trades", labelKey: "orders.tab.trades", active: false },
];

const COLS = [
  "common.date",
  "orders.col.pair",
  "common.type",
  "common.side",
  "common.price",
  "orders.col.trigger",
  "orders.col.qty",
  "orders.col.filled",
  "common.status",
  "",
];

const ALL = "ALL";

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

/** Stop 트리거 조건 (Binance 의미론: SL BUY ≥ / SL SELL ≤ / TP BUY ≤ / TP SELL ≥) */
function triggerCondition(order: Order): { gte: boolean; price: string } | null {
  if (!order.stopPrice) return null;
  const isStopLoss = order.type === "STOP_LOSS" || order.type === "STOP_LOSS_LIMIT";
  const isTakeProfit = order.type === "TAKE_PROFIT" || order.type === "TAKE_PROFIT_LIMIT";
  if (!isStopLoss && !isTakeProfit) return null;
  const gte = isStopLoss ? order.side === "BUY" : order.side === "SELL";
  return { gte, price: order.stopPrice };
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

export default function OpenOrdersPage() {
  const t = useT();
  useUserStream();
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const tickers = useAllTickers();
  const [symbol, setSymbol] = useState<string>(ALL);
  const [side, setSide] = useState<string>(ALL);
  const [error, setError] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  const { data: orders, isLoading } = useOpenOrders(symbol === ALL ? undefined : symbol);
  const cancelOrder = useCancelOrder();
  const cancelAll = useCancelAllOrders();

  const spotSymbols = useMemo(
    () => (tickers ?? []).filter((t) => t.marketType === "SPOT").map((t) => t.symbol),
    [tickers],
  );
  const tickerMap = useMemo(() => {
    const map = new Map<string, Ticker24h>();
    for (const t of tickers ?? []) if (t.marketType === "SPOT") map.set(t.symbol, t);
    return map;
  }, [tickers]);

  const rows = useMemo(() => {
    const list = (orders ?? []).filter((o) => side === ALL || o.side === (side as OrderSide));
    return [...list].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [orders, side]);

  const onCancel = (id: string) => {
    setError(null);
    setCancelingId(id);
    cancelOrder.mutate(id, {
      onError: (err) =>
        setError(err instanceof Error ? err.message : t("orders.cancelFailed")),
      onSettled: () => setCancelingId(null),
    });
  };

  const onCancelAll = () => {
    if (symbol === ALL) return;
    setError(null);
    cancelAll.mutate(symbol, {
      onError: (err) =>
        setError(err instanceof Error ? err.message : t("orders.cancelAllFailed")),
    });
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
          onChange={(e) => setSymbol(e.target.value)}
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
        <div className="flex-1" />
        <button
          onClick={onCancelAll}
          disabled={symbol === ALL || cancelAll.isPending || (orders ?? []).length === 0}
          title={symbol === ALL ? t("orders.cancelAllHint") : undefined}
          className="h-7 px-2.5 text-[11px] text-down hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
        >
          {cancelAll.isPending ? t("orders.canceling") : t("orders.cancelAll")}
        </button>
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
                      i === 0 || i === 1 ? "text-left" : "text-right"
                    }`}
                  >
                    {c ? t(c) : ""}
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
                    {t("orders.empty.openSignedOut")}
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
                    {t("orders.empty.open")}
                  </td>
                </tr>
              )}
              {!signedOut &&
                !loading &&
                rows.map((o) => {
                  const ticker = tickerMap.get(o.tickerSymbol);
                  const trigger = triggerCondition(o);
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
                      <td className="px-3 py-2 text-right tnum text-text-dim whitespace-nowrap">
                        {trigger ? (
                          <>
                            {t(trigger.gte ? "orders.triggerGte" : "orders.triggerLte", {
                              price: trigger.price,
                            })}
                            {o.triggeredAt && (
                              <span className="ml-1 text-[10px] text-accent">
                                {t("orders.triggered")}
                              </span>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tnum">{qtyDisplay(o, ticker)}</td>
                      <td className="px-3 py-2 text-right tnum text-text-dim">{o.executedQty}</td>
                      <td className="px-3 py-2 text-right text-text-dim">{typeLabel(o.status)}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => onCancel(o.id)}
                          disabled={cancelingId === o.id}
                          className="text-[11px] text-down hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {cancelingId === o.id ? t("orders.canceling") : t("common.cancel")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
