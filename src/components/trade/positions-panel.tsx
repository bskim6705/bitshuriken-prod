"use client";

import { useMemo, useState } from "react";
import { PanelEmpty } from "@/components/ui/panel";
import {
  PanelTable,
  PositionsPanelShell,
  QueryTabBody,
  RowActionButton,
  formatDateTime,
  myTradeColumns,
  myTradeRowKey,
  useSymbolRows,
  type PanelColumn,
} from "@/components/common/positions-panel";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useExchangeInfo } from "@/lib/hooks/use-market";
import { useT } from "@/lib/i18n/provider";

type Translate = ReturnType<typeof useT>;
import {
  useBalances,
  useCancelAllOrders,
  useCancelOco,
  useCancelOrder,
  useMyTrades,
  useOpenOrders,
  useOrderHistory,
  useUserStream,
} from "@/lib/hooks/use-trading";
import type { Balance, MyTrade, Order } from "@/lib/types/trading";

type PanelTab = "open" | "history" | "trades" | "assets";

const orderSymbolOf = (o: Order) => o.tickerSymbol;
const tradeSymbolOf = (t: MyTrade) => t.symbol;

/** stop 주문 트리거 조건 텍스트 (예: 'Stop >= 50000.00'). */
function triggerText(o: Order, t: Translate): string | null {
  if (!o.stopPrice) return null;
  const takeProfit = o.type === "TAKE_PROFIT" || o.type === "TAKE_PROFIT_LIMIT";
  const gte = (o.side === "BUY") !== takeProfit;
  return gte
    ? t("trade.positions.triggerGte", { price: o.stopPrice })
    : t("trade.positions.triggerLte", { price: o.stopPrice });
}

function assetColumns(t: Translate): PanelColumn<Balance>[] {
  return [
    { key: "asset", header: t("common.asset"), tdClass: "text-text", cell: (b) => b.asset },
    { key: "free", header: t("common.available"), tdClass: "text-text", cell: (b) => b.free },
    { key: "locked", header: t("trade.positions.colInOrder"), tdClass: "text-text", cell: (b) => b.locked },
    {
      key: "total",
      header: t("common.total"),
      tdClass: "text-text",
      cell: (b) => (Number(b.free) + Number(b.locked)).toFixed(8),
    },
  ];
}

export function PositionsPanel({ symbol }: { symbol: string }) {
  const t = useT();
  useUserStream();
  const { data: user } = useCurrentUser();
  const [tab, setTab] = useState<PanelTab>("open");
  const [hideOthers, setHideOthers] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const openOrders = useOpenOrders();
  const history = useOrderHistory();
  const trades = useMyTrades();
  const balances = useBalances();
  const { data: exchangeInfo } = useExchangeInfo();

  const cancelOrderM = useCancelOrder();
  const cancelOcoM = useCancelOco();
  const cancelAllM = useCancelAllOrders();

  const quoteBySymbol = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of exchangeInfo?.symbols ?? []) m.set(s.symbol, s.quoteAsset);
    return m;
  }, [exchangeInfo]);

  const open = useSymbolRows(openOrders.data, hideOthers, symbol, orderSymbolOf);
  const historyRows = useSymbolRows(history.data, hideOthers, symbol, orderSymbolOf);
  const tradeRows = useSymbolRows(trades.data, hideOthers, symbol, tradeSymbolOf);

  const openForSymbol = useMemo(
    () => (openOrders.data ?? []).filter((o) => o.tickerSymbol === symbol),
    [openOrders.data, symbol],
  );

  function qtyDisplay(o: Order): string {
    if (o.origQty) return o.origQty;
    if (o.origQuoteQty) {
      const quote = quoteBySymbol.get(o.tickerSymbol);
      return quote ? `${o.origQuoteQty} ${quote}` : o.origQuoteQty;
    }
    return "—";
  }

  function cancelPendingFor(o: Order): boolean {
    if (o.orderListId) return cancelOcoM.isPending && cancelOcoM.variables === o.orderListId;
    return cancelOrderM.isPending && cancelOrderM.variables === o.id;
  }

  function handleCancel(o: Order) {
    setActionError(null);
    const opts = { onError: (e: Error) => setActionError(e.message) };
    // OCO 레그는 리스트 전체 취소 (Binance 의미론)
    if (o.orderListId) cancelOcoM.mutate(o.orderListId, opts);
    else cancelOrderM.mutate(o.id, opts);
  }

  function handleCancelAll() {
    setActionError(null);
    cancelAllM.mutate(symbol, { onError: (e: Error) => setActionError(e.message) });
  }

  function orderColumns(withStatus: boolean): PanelColumn<Order>[] {
    return [
      { key: "date", header: t("common.date"), tdClass: "text-text-dim", cell: (o) => formatDateTime(o.createdAt) },
      { key: "pair", header: t("trade.positions.colPair"), tdClass: "text-text", cell: (o) => o.tickerSymbol },
      {
        key: "type",
        header: t("common.type"),
        tdClass: "text-text",
        cell: (o) => (
          <>
            {o.type}
            {o.orderListId && (
              <span className="ml-1 px-1 text-[10px] border border-line-strong text-text-dim">
                OCO
              </span>
            )}
          </>
        ),
      },
      {
        key: "side",
        header: t("common.side"),
        tdClass: (o) => (o.side === "BUY" ? "text-up" : "text-down"),
        cell: (o) => o.side,
      },
      { key: "price", header: t("common.price"), tdClass: "text-text", cell: (o) => o.price ?? "—" },
      { key: "qty", header: t("widgets.orderBook.qty"), tdClass: "text-text", cell: (o) => qtyDisplay(o) },
      { key: "filled", header: t("trade.positions.colFilled"), tdClass: "text-text", cell: (o) => o.executedQty },
      { key: "trigger", header: t("trade.positions.colTrigger"), tdClass: "text-text-dim", cell: (o) => triggerText(o, t) ?? "—" },
      withStatus
        ? { key: "status", header: t("common.status"), tdClass: "text-text-dim", cell: (o) => o.status }
        : {
            key: "actions",
            header: t("trade.positions.colActions"),
            thClass: "text-right",
            tdClass: "text-right",
            cell: (o) => (
              <RowActionButton
                busy={cancelPendingFor(o)}
                busyLabel={t("trade.positions.canceling")}
                label={t("trade.positions.cancel")}
                onClick={() => handleCancel(o)}
              />
            ),
          },
    ];
  }

  function renderBody() {
    if (user === null) return <PanelEmpty hint={t("trade.positions.loginHint")} />;
    switch (tab) {
      case "open":
        return (
          <QueryTabBody
            isPending={openOrders.isPending}
            isError={openOrders.isError}
            errorHint={t("trade.positions.openError")}
            isEmpty={open.length === 0}
            emptyHint={t("trade.positions.openEmpty")}
          >
            {() => <PanelTable columns={orderColumns(false)} rows={open} rowKey={(o) => o.id} />}
          </QueryTabBody>
        );
      case "history":
        return (
          <QueryTabBody
            isPending={history.isPending}
            isError={history.isError}
            errorHint={t("trade.positions.historyError")}
            isEmpty={historyRows.length === 0}
            emptyHint={t("trade.positions.historyEmpty")}
          >
            {() => (
              <PanelTable columns={orderColumns(true)} rows={historyRows} rowKey={(o) => o.id} />
            )}
          </QueryTabBody>
        );
      case "trades":
        return (
          <QueryTabBody
            isPending={trades.isPending}
            isError={trades.isError}
            errorHint={t("trade.positions.tradesError")}
            isEmpty={tradeRows.length === 0}
            emptyHint={t("trade.positions.tradesEmpty")}
          >
            {() => (
              <PanelTable
                columns={myTradeColumns(t("trade.positions.colPair"), {
                  date: t("common.date"),
                  side: t("common.side"),
                  price: t("common.price"),
                  qty: t("widgets.orderBook.qty"),
                  fee: t("common.fee"),
                  role: t("widgets.trade.role"),
                  maker: t("widgets.trade.maker"),
                  taker: t("widgets.trade.taker"),
                })}
                rows={tradeRows}
                rowKey={myTradeRowKey}
              />
            )}
          </QueryTabBody>
        );
      case "assets":
        return (
          <QueryTabBody
            isPending={balances.isPending}
            isError={balances.isError}
            errorHint={t("trade.positions.assetsError")}
            isEmpty={(balances.data ?? []).length === 0}
            emptyHint={t("trade.positions.assetsEmpty")}
          >
            {() => (
              <PanelTable
                columns={assetColumns(t)}
                rows={balances.data ?? []}
                rowKey={(b) => b.asset}
              />
            )}
          </QueryTabBody>
        );
    }
  }

  return (
    <PositionsPanelShell
      tabs={[
        { key: "open", label: t("trade.positions.openOrders"), count: openOrders.data ? open.length : undefined },
        { key: "history", label: t("trade.positions.orderHistory") },
        { key: "trades", label: t("trade.positions.tradeHistory") },
        { key: "assets", label: t("trade.positions.assets") },
      ]}
      active={tab}
      onSelect={setTab}
      hideOthers={hideOthers}
      onHideOthersChange={setHideOthers}
      hideOthersLabel={t("trade.positions.hideOtherPairs")}
      headerExtra={
        <button
          type="button"
          className="text-[11px] text-accent hover:underline whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
          disabled={cancelAllM.isPending || openForSymbol.length === 0}
          onClick={handleCancelAll}
        >
          {cancelAllM.isPending ? t("trade.positions.canceling") : t("trade.positions.cancelAll")}
        </button>
      }
      actionError={actionError}
    >
      {renderBody()}
    </PositionsPanelShell>
  );
}
