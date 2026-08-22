"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { LabeledInput } from "@/components/ui/input";
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
import { useT } from "@/lib/i18n/provider";
import { useFuturesMarkPrice, useFuturesSymbolInfo } from "@/lib/hooks/use-futures-market";
import {
  useCancelFuturesOrder,
  useCreateFuturesOrder,
  useFuturesIncome,
  useFuturesMyTrades,
  useFuturesOpenOrders,
  useFuturesOrderHistory,
  useFuturesPositions,
  useUpdateFuturesPosition,
} from "@/lib/hooks/use-futures-trading";
import { useMarginCallNotice } from "@/lib/hooks/use-futures-user";
import { isPos, decimalsOf, normDecimal } from "@/lib/hooks/use-order-form-state";
import type { OrderSide } from "@/lib/types/market";
import type { MyTrade } from "@/lib/types/trading";
import type { FuturesIncome, FuturesOrder, MarginCallEvent, Position } from "@/lib/types/futures";

type PanelTab = "positions" | "open" | "history" | "trades" | "income";

const orderSymbolOf = (o: FuturesOrder) => o.tickerSymbol;
const tradeSymbolOf = (t: MyTrade) => t.symbol;
const incomeSymbolOf = (i: FuturesIncome) => i.tickerSymbol;

// 파생 필드(liq.price 등)는 positionUpdate merge 후 null — 주기 재조회로 보충 (이벤트 유실 폴백 겸용)
const POSITIONS_POLL_MS = 5000;

function absQty(qty: string): string {
  return qty.startsWith("-") ? qty.slice(1) : qty;
}

/** 표시용 근사 UPNL = (mark − entry) × qty. mark 미형성 시 null. */
function upnlOf(p: Position, mark: string | null): number | null {
  if (mark === null) return null;
  const v = (Number(mark) - Number(p.entryPrice)) * Number(p.qty);
  return Number.isFinite(v) ? v : null;
}

function signedTone(n: number): string {
  return n > 0 ? "text-up" : n < 0 ? "text-down" : "text-text";
}

// 청산 사전 경고 — 받은 MARGIN_CALL을 dismissable 배너로 표시 (알림 전용)
function MarginCallBanner({
  notices,
  onDismiss,
}: {
  notices: MarginCallEvent[];
  onDismiss: (key: string) => void;
}) {
  const t = useT();
  if (notices.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-accent/40">
      {notices.map((n) => {
        const key = n.marginMode === "CROSS" ? "CROSS" : n.symbol;
        const pct = (Number(n.marginRatio) * 100).toFixed(1);
        const scope = n.marginMode === "CROSS" ? t("futures.marginCall.crossAccount") : n.symbol;
        return (
          <div
            key={key}
            role="alert"
            className="flex items-center gap-2 px-3 py-1 text-[11px] text-accent"
          >
            <span className="font-medium">{t("futures.marginCall.title")}</span>
            <span className="text-text-dim">
              {t("futures.marginCall.body", { scope, pct })}
            </span>
            <button
              type="button"
              aria-label={t("futures.marginCall.dismiss")}
              onClick={() => onDismiss(key)}
              className="ml-auto text-text-dim hover:text-text"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 포지션에 reduceOnly stop(TP 또는 SL)을 건다. mark 트리거 시 market으로 청산.
 * BE reduceOnly 용량 규칙(Σ보유 reduceOnly ≤ 포지션)상 TP·SL 전량을 동시에 둘 수 없어 1건씩 접수.
 */
function TpSlDialog({ position, onClose }: { position: Position; onClose: () => void }) {
  const t = useT();
  const orderMut = useCreateFuturesOrder();
  const info = useFuturesSymbolInfo(position.symbol);
  const liveMark = useFuturesMarkPrice(position.symbol);
  const [kind, setKind] = useState<"TP" | "SL">("TP");
  const [trigger, setTrigger] = useState("");
  const [qty, setQty] = useState(absQty(position.qty));
  const [error, setError] = useState<string | null>(null);

  const isLong = Number(position.qty) > 0;
  const closingSide: OrderSide = isLong ? "SELL" : "BUY";
  const mark = liveMark?.markPrice ?? position.markPrice;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function validate(): string | null {
    if (!info) return t("futures.tpsl.errNoInfo");
    if (!isPos(trigger)) return t("futures.tpsl.errTrigger");
    if (decimalsOf(trigger) > info.pricePrecision)
      return t("futures.tpsl.errTriggerDecimals", { n: info.pricePrecision });
    if (!isPos(qty)) return t("futures.tpsl.errQty");
    if (decimalsOf(qty) > info.qtyPrecision) return t("futures.tpsl.errQtyDecimals", { n: info.qtyPrecision });
    if (Number(qty) > Number(absQty(position.qty))) return t("futures.tpsl.errQtyExceeds");
    return null;
  }

  async function confirm() {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    try {
      // market-stop(close at market on trigger): TP=TAKE_PROFIT, SL=STOP_LOSS — 방향 검증은 BE
      await orderMut.mutateAsync({
        symbol: position.symbol,
        type: kind === "TP" ? "TAKE_PROFIT" : "STOP_LOSS",
        side: closingSide,
        timeInForce: "IOC",
        stopPrice: normDecimal(trigger),
        qty: normDecimal(qty),
        reduceOnly: true,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("futures.tpsl.errFailed"));
    }
  }

  const hint =
    kind === "TP"
      ? isLong
        ? t("futures.tpsl.tpLongHint")
        : t("futures.tpsl.tpShortHint")
      : isLong
        ? t("futures.tpsl.slLongHint")
        : t("futures.tpsl.slShortHint");

  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("futures.tpsl.dialogLabel")}
        className="relative w-72 bg-surface border border-line p-4 flex flex-col gap-3"
      >
        <h3 className="text-[13px] font-medium">
          {t("futures.tpsl.title", { symbol: position.symbol })}
          <span className="ml-1 text-[11px] text-text-dim">{isLong ? t("futures.cell.long") : t("futures.cell.short")}</span>
        </h3>
        <div className="flex items-center justify-between text-[11px] text-text-dim">
          <span>{t("futures.tpsl.mark")}</span>
          <span className="tnum">{mark ?? "—"}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(["TP", "SL"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setKind(k);
                setError(null);
              }}
              className={`h-8 text-[12px] border ${
                kind === k
                  ? "border-accent text-accent bg-raised"
                  : "border-line text-text-dim hover:border-line-strong"
              }`}
            >
              {k === "TP" ? t("futures.tpsl.takeProfit") : t("futures.tpsl.stopLoss")}
            </button>
          ))}
        </div>
        <LabeledInput
          label={t("futures.tpsl.trigger")}
          suffix={info?.quoteAsset ?? ""}
          value={trigger}
          onChange={(e) => {
            setTrigger(e.target.value);
            setError(null);
          }}
          placeholder="0"
          inputMode="decimal"
        />
        <LabeledInput
          label={t("futures.orderForm.qty")}
          suffix={info?.baseAsset ?? ""}
          value={qty}
          onChange={(e) => {
            setQty(e.target.value);
            setError(null);
          }}
          placeholder="0"
          inputMode="decimal"
        />
        <p className="text-[10px] text-text-muted">{hint}</p>
        {error && <p className="text-[11px] text-down">{error}</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={orderMut.isPending || !info}
            onClick={() => void confirm()}
          >
            {orderMut.isPending ? t("futures.tpsl.placing") : t("futures.dialog.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}

const CLOSE_PCTS = [25, 50, 75, 100] as const;

/** 부분/전량 청산 — reduceOnly MARKET. qty 기본 전량, % 버튼 제공. */
function CloseDialog({ position, onClose }: { position: Position; onClose: () => void }) {
  const t = useT();
  const orderMut = useCreateFuturesOrder();
  const info = useFuturesSymbolInfo(position.symbol);
  const full = absQty(position.qty);
  const [qty, setQty] = useState(full);
  const [error, setError] = useState<string | null>(null);

  const closingSide: OrderSide = Number(position.qty) > 0 ? "SELL" : "BUY";
  const qtyPrec = info?.qtyPrecision ?? 8;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function setPct(pct: number) {
    setError(null);
    setQty(pct === 100 ? full : ((Number(full) * pct) / 100).toFixed(qtyPrec));
  }

  function validate(): string | null {
    if (!isPos(qty)) return t("futures.close.errQty");
    if (decimalsOf(qty) > qtyPrec) return t("futures.close.errQtyDecimals", { n: qtyPrec });
    if (Number(qty) > Number(full)) return t("futures.close.errQtyExceeds");
    return null;
  }

  async function confirm() {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    try {
      await orderMut.mutateAsync({
        symbol: position.symbol,
        type: "MARKET",
        side: closingSide,
        timeInForce: "IOC",
        qty: normDecimal(qty),
        reduceOnly: true,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("futures.close.errFailed"));
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("futures.close.dialogLabel")}
        className="relative w-72 bg-surface border border-line p-4 flex flex-col gap-3"
      >
        <h3 className="text-[13px] font-medium">
          {t("futures.close.title", { symbol: position.symbol })}
          <span className="ml-1 text-[11px] text-text-dim">
            {Number(position.qty) > 0 ? t("futures.cell.long") : t("futures.cell.short")} · {full}
          </span>
        </h3>
        <LabeledInput
          label={t("futures.orderForm.qty")}
          suffix={info?.baseAsset ?? ""}
          value={qty}
          onChange={(e) => {
            setQty(e.target.value);
            setError(null);
          }}
          placeholder="0"
          inputMode="decimal"
        />
        <div className="grid grid-cols-4 gap-1">
          {CLOSE_PCTS.map((pct) => (
            <button
              key={pct}
              type="button"
              onClick={() => setPct(pct)}
              className="h-7 text-[11px] border border-line text-text-dim hover:border-line-strong"
            >
              {pct}%
            </button>
          ))}
        </div>
        <p className="text-[10px] text-text-muted">{t("futures.close.hint")}</p>
        {error && <p className="text-[11px] text-down">{error}</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={orderMut.isPending}
            onClick={() => void confirm()}
          >
            {orderMut.isPending ? t("futures.close.closing") : t("futures.action.close")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 격리마진 추가/제거 — marginDelta(+/−). ISOLATED 전용 (cross는 BE 거부). */
function MarginDialog({ position, onClose }: { position: Position; onClose: () => void }) {
  const t = useT();
  const updateMut = useUpdateFuturesPosition();
  const info = useFuturesSymbolInfo(position.symbol);
  const [mode, setMode] = useState<"ADD" | "REMOVE">("ADD");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function validate(): string | null {
    if (!isPos(amount)) return t("futures.margin.errAmount");
    if (decimalsOf(amount) > 8) return t("futures.margin.errAmountDecimals");
    return null;
  }

  async function confirm() {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    const delta = mode === "ADD" ? normDecimal(amount) : `-${normDecimal(amount)}`;
    try {
      await updateMut.mutateAsync({ symbol: position.symbol, req: { marginDelta: delta } });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("futures.margin.errFailed"));
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("futures.margin.dialogLabel")}
        className="relative w-72 bg-surface border border-line p-4 flex flex-col gap-3"
      >
        <h3 className="text-[13px] font-medium">{t("futures.margin.title", { symbol: position.symbol })}</h3>
        <div className="flex items-center justify-between text-[11px] text-text-dim">
          <span>{t("futures.margin.current")}</span>
          <span className="tnum">
            {position.isolatedMargin} {info?.quoteAsset ?? ""}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(["ADD", "REMOVE"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`h-8 text-[12px] border ${
                mode === m
                  ? "border-accent text-accent bg-raised"
                  : "border-line text-text-dim hover:border-line-strong"
              }`}
            >
              {m === "ADD" ? t("futures.margin.add") : t("futures.margin.remove")}
            </button>
          ))}
        </div>
        <LabeledInput
          label={t("futures.margin.amount")}
          suffix={info?.quoteAsset ?? ""}
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setError(null);
          }}
          placeholder="0"
          inputMode="decimal"
        />
        <p className="text-[10px] text-text-muted">
          {mode === "ADD"
            ? t("futures.margin.addHint")
            : t("futures.margin.removeHint")}
        </p>
        {error && <p className="text-[11px] text-down">{error}</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={updateMut.isPending}
            onClick={() => void confirm()}
          >
            {updateMut.isPending ? t("futures.dialog.confirming") : t("futures.dialog.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function FuturesPositionsPanel({ symbol }: { symbol: string }) {
  const t = useT();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();
  const [tab, setTab] = useState<PanelTab>("positions");
  const [hideOthers, setHideOthers] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tpSlFor, setTpSlFor] = useState<Position | null>(null);
  const [closeFor, setCloseFor] = useState<Position | null>(null);
  const [marginFor, setMarginFor] = useState<Position | null>(null);

  const positions = useFuturesPositions();
  const openOrders = useFuturesOpenOrders();
  const history = useFuturesOrderHistory();
  const trades = useFuturesMyTrades();
  const income = useFuturesIncome();
  const liveMark = useFuturesMarkPrice(symbol);
  const marginCall = useMarginCallNotice();

  const cancelM = useCancelFuturesOrder();

  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    const timer = window.setInterval(() => {
      void qc.invalidateQueries({ queryKey: ["futures", "positions"] });
    }, POSITIONS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [qc, userId]);

  const positionRows = useMemo(() => {
    const rows = (positions.data ?? []).filter((p) => Number(p.qty) !== 0);
    return hideOthers ? rows.filter((p) => p.symbol === symbol) : rows;
  }, [positions.data, hideOthers, symbol]);

  const openRows = useSymbolRows(openOrders.data, hideOthers, symbol, orderSymbolOf);
  const historyRows = useSymbolRows(history.data, hideOthers, symbol, orderSymbolOf);
  const tradeRows = useSymbolRows(trades.data, hideOthers, symbol, tradeSymbolOf);
  const incomeRows = useSymbolRows(income.data, hideOthers, symbol, incomeSymbolOf);

  const positionCount = useMemo(
    () => (positions.data ?? []).filter((p) => Number(p.qty) !== 0).length,
    [positions.data],
  );

  function cancelPendingFor(o: FuturesOrder): boolean {
    return cancelM.isPending && cancelM.variables === o.id;
  }

  function handleCancel(o: FuturesOrder) {
    setActionError(null);
    cancelM.mutate(o.id, { onError: (e: Error) => setActionError(e.message) });
  }

  /** 현재 심볼은 라이브 markPrice 스트림 우선, 그 외는 스냅샷 값. */
  function markOf(p: Position): string | null {
    return p.symbol === symbol ? liveMark?.markPrice ?? p.markPrice : p.markPrice;
  }

  function positionColumns(): PanelColumn<Position>[] {
    return [
      {
        key: "symbol",
        header: t("futures.col.symbol"),
        tdClass: "text-text",
        cell: (p) => (
          <>
            {p.symbol}
            <span className="ml-1 text-[10px] text-text-muted">
              {p.marginMode === "CROSS" ? t("futures.cell.cross") : t("futures.cell.iso")} {p.leverage}x
            </span>
            {p.status === "LIQUIDATING" && (
              <span className="ml-1 px-1 text-[10px] border border-down text-down">
                LIQUIDATING
              </span>
            )}
          </>
        ),
      },
      {
        key: "size",
        header: t("futures.col.size"),
        tdClass: (p) => (Number(p.qty) > 0 ? "text-up" : "text-down"),
        cell: (p) => p.qty,
      },
      { key: "entry", header: t("futures.col.entryPrice"), tdClass: "text-text", cell: (p) => p.entryPrice },
      { key: "mark", header: t("futures.col.markPrice"), tdClass: "text-text", cell: (p) => markOf(p) ?? "—" },
      {
        key: "liq",
        header: t("futures.col.liqPrice"),
        tdClass: "text-text",
        cell: (p) => p.liquidationPrice ?? "—",
      },
      { key: "margin", header: t("futures.col.margin"), tdClass: "text-text", cell: (p) => p.isolatedMargin },
      {
        key: "pnl",
        header: t("futures.col.pnlRoe"),
        cell: (p) => {
          const upnl = upnlOf(p, markOf(p));
          const margin = Number(p.isolatedMargin);
          const roe = upnl !== null && margin > 0 ? (upnl / margin) * 100 : null;
          return upnl !== null ? (
            <span className={signedTone(upnl)}>
              {upnl.toFixed(2)}
              {roe !== null && ` (${roe.toFixed(2)}%)`}
            </span>
          ) : (
            <span className="text-text-dim">—</span>
          );
        },
      },
      {
        key: "actions",
        header: t("futures.col.actions"),
        thClass: "text-right",
        tdClass: "text-right",
        cell: (p) => (
          <div className="flex items-center justify-end gap-1.5">
            <RowActionButton
              busy={false}
              busyLabel=""
              label={t("futures.action.tpSl")}
              disabled={p.status === "LIQUIDATING"}
              onClick={() => {
                setActionError(null);
                setTpSlFor(p);
              }}
            />
            {p.marginMode === "ISOLATED" && (
              <RowActionButton
                busy={false}
                busyLabel=""
                label={t("futures.action.margin")}
                disabled={p.status === "LIQUIDATING"}
                onClick={() => {
                  setActionError(null);
                  setMarginFor(p);
                }}
              />
            )}
            <RowActionButton
              busy={false}
              busyLabel=""
              label={t("futures.action.close")}
              disabled={p.status === "LIQUIDATING"}
              onClick={() => {
                setActionError(null);
                setCloseFor(p);
              }}
            />
          </div>
        ),
      },
    ];
  }

  function orderColumns(withStatus: boolean): PanelColumn<FuturesOrder>[] {
    return [
      { key: "date", header: t("futures.col.date"), tdClass: "text-text-dim", cell: (o) => formatDateTime(o.createdAt) },
      { key: "symbol", header: t("futures.col.symbol"), tdClass: "text-text", cell: (o) => o.tickerSymbol },
      {
        key: "type",
        header: t("futures.col.type"),
        tdClass: "text-text",
        cell: (o) => (
          <>
            {o.type}
            {o.liquidation && (
              <span className="ml-1 px-1 text-[10px] border border-down text-down">LIQ</span>
            )}
          </>
        ),
      },
      {
        key: "side",
        header: t("futures.col.side"),
        tdClass: (o) => (o.side === "BUY" ? "text-up" : "text-down"),
        cell: (o) => o.side,
      },
      {
        key: "price",
        header: t("futures.col.price"),
        tdClass: "text-text",
        cell: (o) =>
          o.stopPrice
            ? `${o.stopPrice} (${t("futures.cell.stop")})${o.price ? ` → ${o.price}` : ""}`
            : o.price ?? "—",
      },
      { key: "qty", header: t("futures.col.qty"), tdClass: "text-text", cell: (o) => o.origQty ?? "—" },
      { key: "filled", header: t("futures.col.filled"), tdClass: "text-text", cell: (o) => o.executedQty },
      {
        key: "reduceOnly",
        header: t("futures.col.reduceOnly"),
        tdClass: "text-text-dim",
        cell: (o) => (o.reduceOnly ? t("futures.cell.yes") : "—"),
      },
      withStatus
        ? { key: "status", header: t("futures.col.status"), tdClass: "text-text-dim", cell: (o) => o.status }
        : {
            key: "actions",
            header: t("futures.col.actions"),
            thClass: "text-right",
            tdClass: "text-right",
            cell: (o) => (
              <RowActionButton
                busy={cancelPendingFor(o)}
                busyLabel={t("futures.action.canceling")}
                label={t("futures.action.cancel")}
                onClick={() => handleCancel(o)}
              />
            ),
          },
    ];
  }

  function incomeColumns(): PanelColumn<FuturesIncome>[] {
    return [
      { key: "date", header: t("futures.col.date"), tdClass: "text-text-dim", cell: (i) => formatDateTime(i.createdAt) },
      { key: "symbol", header: t("futures.col.symbol"), tdClass: "text-text", cell: (i) => i.tickerSymbol ?? "—" },
      { key: "type", header: t("futures.col.type"), tdClass: "text-text", cell: (i) => i.incomeType },
      {
        key: "amount",
        header: t("futures.col.amount"),
        tdClass: (i) => signedTone(Number(i.income)),
        cell: (i) => i.income,
      },
    ];
  }

  function renderBody() {
    if (user === null)
      return <PanelEmpty hint={t("futures.panel.loginHint")} />;
    switch (tab) {
      case "positions":
        return (
          <QueryTabBody
            isPending={positions.isPending}
            isError={positions.isError}
            errorHint={t("futures.panel.positionsError")}
            isEmpty={positionRows.length === 0}
            emptyHint={t("futures.panel.noPositions")}
          >
            {() => (
              <PanelTable columns={positionColumns()} rows={positionRows} rowKey={(p) => p.symbol} />
            )}
          </QueryTabBody>
        );
      case "open":
        return (
          <QueryTabBody
            isPending={openOrders.isPending}
            isError={openOrders.isError}
            errorHint={t("futures.panel.openOrdersError")}
            isEmpty={openRows.length === 0}
            emptyHint={t("futures.panel.noOpenOrders")}
          >
            {() => <PanelTable columns={orderColumns(false)} rows={openRows} rowKey={(o) => o.id} />}
          </QueryTabBody>
        );
      case "history":
        return (
          <QueryTabBody
            isPending={history.isPending}
            isError={history.isError}
            errorHint={t("futures.panel.historyError")}
            isEmpty={historyRows.length === 0}
            emptyHint={t("futures.panel.noHistory")}
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
            errorHint={t("futures.panel.tradesError")}
            isEmpty={tradeRows.length === 0}
            emptyHint={t("futures.panel.noTrades")}
          >
            {() => (
              <PanelTable
                columns={myTradeColumns(t("futures.col.symbol"))}
                rows={tradeRows}
                rowKey={myTradeRowKey}
              />
            )}
          </QueryTabBody>
        );
      case "income":
        return (
          <QueryTabBody
            isPending={income.isPending}
            isError={income.isError}
            errorHint={t("futures.panel.incomeError")}
            isEmpty={incomeRows.length === 0}
            emptyHint={t("futures.panel.noIncome")}
          >
            {() => <PanelTable columns={incomeColumns()} rows={incomeRows} rowKey={(i) => i.id} />}
          </QueryTabBody>
        );
    }
  }

  return (
    <>
    <PositionsPanelShell
      tabs={[
        {
          key: "positions",
          label: t("futures.panel.positions"),
          count: positions.data ? positionCount : undefined,
        },
        {
          key: "open",
          label: t("futures.panel.openOrders"),
          count: openOrders.data ? openOrders.data.length : undefined,
        },
        { key: "history", label: t("futures.panel.orderHistory") },
        { key: "trades", label: t("futures.panel.tradeHistory") },
        { key: "income", label: t("futures.panel.income") },
      ]}
      active={tab}
      onSelect={setTab}
      hideOthers={hideOthers}
      onHideOthersChange={setHideOthers}
      hideOthersLabel={t("futures.panel.hideOthers")}
      banner={<MarginCallBanner notices={marginCall.notices} onDismiss={marginCall.dismiss} />}
      actionError={actionError}
    >
      {renderBody()}
    </PositionsPanelShell>
    {tpSlFor && <TpSlDialog position={tpSlFor} onClose={() => setTpSlFor(null)} />}
    {closeFor && <CloseDialog position={closeFor} onClose={() => setCloseFor(null)} />}
    {marginFor && <MarginDialog position={marginFor} onClose={() => setMarginFor(null)} />}
    </>
  );
}
