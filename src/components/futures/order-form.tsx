"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { LabeledInput } from "@/components/ui/input";
import {
  CheckboxRow,
  FormTabs,
  GuestCta,
  InfoRow,
  StatusMessages,
  TifSelector,
} from "@/components/common/order-form";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useT } from "@/lib/i18n/provider";
import {
  useFuturesMarkPrice,
  useFuturesSymbolInfo,
  useFuturesTicker,
} from "@/lib/hooks/use-futures-market";
import {
  isPos,
  normDecimal,
  decimalsOf,
  useOrderFormState,
} from "@/lib/hooks/use-order-form-state";
import {
  useCreateFuturesOrder,
  useFuturesBalances,
  useFuturesPositions,
  useUpdateFuturesPosition,
} from "@/lib/hooks/use-futures-trading";
import type { OrderSide } from "@/lib/types/market";
import type { TimeInForce } from "@/lib/types/trading";
import type { CreateFuturesOrderReq, FuturesOrderType, MarginMode } from "@/lib/types/futures";

type TabKey = "limit" | "market" | "post-only" | "stop-limit" | "stop-market";

const TABS: { key: TabKey; labelKey: string }[] = [
  { key: "limit", labelKey: "futures.orderForm.tab.limit" },
  { key: "market", labelKey: "futures.orderForm.tab.market" },
  { key: "post-only", labelKey: "futures.orderForm.tab.postOnly" },
  { key: "stop-limit", labelKey: "futures.orderForm.tab.stopLimit" },
  { key: "stop-market", labelKey: "futures.orderForm.tab.stopMarket" },
];

// LIMIT만 TIF 선택 (MARKET=IOC, POST_ONLY=GTC 고정)
const TIF_OPTIONS: TimeInForce[] = ["GTC", "IOC", "FOK"];

const DIGITS_RE = /^\d*$/;

// Position 행이 없으면 BE Position 스키마 기본값과 동일한 10x
const DEFAULT_LEVERAGE = 10;

function LeverageDialog({
  symbol,
  current,
  maxLeverage,
  marginMode,
  onClose,
}: {
  symbol: string;
  current: number;
  maxLeverage: number;
  marginMode: MarginMode;
  onClose: () => void;
}) {
  const t = useT();
  const updateMut = useUpdateFuturesPosition();
  const [lev, setLev] = useState(String(current));
  const [error, setError] = useState<string | null>(null);

  const levNum = DIGITS_RE.test(lev) && lev !== "" ? Number(lev) : NaN;
  const valid = Number.isInteger(levNum) && levNum >= 1 && levNum <= maxLeverage;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function confirm() {
    if (!valid) return;
    setError(null);
    try {
      await updateMut.mutateAsync({ symbol, req: { leverage: levNum } });
      onClose();
    } catch (err) {
      // BE 메시지 그대로 (예: leverage can only be changed with no open position)
      setError(err instanceof Error ? err.message : t("futures.leverage.failed"));
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("futures.leverage.title")}
        className="relative w-72 bg-surface border border-line p-4 flex flex-col gap-3"
      >
        <h3 className="text-[13px] font-medium">{t("futures.leverage.title")}</h3>
        <div className="flex items-center justify-between text-[11px] text-text-dim">
          <span>
            {symbol} · {marginMode === "CROSS" ? t("futures.orderForm.cross") : t("futures.orderForm.isolated")}
          </span>
          <span className="tnum">{t("futures.leverage.max", { n: maxLeverage })}</span>
        </div>
        <LabeledInput
          label={t("futures.leverage.label")}
          suffix="x"
          value={lev}
          onChange={(e) => {
            if (!DIGITS_RE.test(e.target.value)) return;
            setLev(e.target.value);
            setError(null);
          }}
          inputMode="numeric"
          placeholder="1"
        />
        <input
          type="range"
          min={1}
          max={maxLeverage}
          step={1}
          value={valid ? levNum : current}
          onChange={(e) => {
            setLev(e.target.value);
            setError(null);
          }}
          aria-label={t("futures.leverage.slider")}
          className="w-full accent-accent"
        />
        <div className="flex justify-between text-[10px] text-text-muted tnum">
          <span>1x</span>
          <span>{maxLeverage}x</span>
        </div>
        {error && <p className="text-[11px] text-down">{error}</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!valid || updateMut.isPending}
            onClick={() => void confirm()}
          >
            {updateMut.isPending ? t("futures.dialog.confirming") : t("futures.dialog.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}

const MARGIN_MODES: { key: MarginMode; labelKey: string; hintKey: string }[] = [
  { key: "CROSS", labelKey: "futures.orderForm.cross", hintKey: "futures.marginMode.crossHint" },
  { key: "ISOLATED", labelKey: "futures.orderForm.isolated", hintKey: "futures.marginMode.isolatedHint" },
];

function MarginModeDialog({
  symbol,
  current,
  onClose,
}: {
  symbol: string;
  current: MarginMode;
  onClose: () => void;
}) {
  const t = useT();
  const updateMut = useUpdateFuturesPosition();
  const [mode, setMode] = useState<MarginMode>(current);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function confirm() {
    if (mode === current) {
      onClose();
      return;
    }
    setError(null);
    try {
      await updateMut.mutateAsync({ symbol, req: { marginMode: mode } });
      onClose();
    } catch (err) {
      // BE 메시지 그대로 (예: margin mode can only be changed with no open position)
      setError(err instanceof Error ? err.message : t("futures.marginMode.failed"));
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("futures.marginMode.dialogLabel")}
        className="relative w-72 bg-surface border border-line p-4 flex flex-col gap-3"
      >
        <h3 className="text-[13px] font-medium">{t("futures.marginMode.title", { symbol })}</h3>
        <div className="grid grid-cols-2 gap-2">
          {MARGIN_MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => {
                setMode(m.key);
                setError(null);
              }}
              className={`h-8 text-[12px] border ${
                mode === m.key
                  ? "border-accent text-accent bg-raised"
                  : "border-line text-text-dim hover:border-line-strong"
              }`}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-text-muted">
          {(() => {
            const hintKey = MARGIN_MODES.find((m) => m.key === mode)?.hintKey;
            return hintKey ? t(hintKey) : "";
          })()}
        </p>
        <p className="text-[10px] text-text-muted">{t("futures.marginMode.changeableHint")}</p>
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

export function FuturesOrderForm({ symbol }: { symbol: string }) {
  const t = useT();
  const { data: user } = useCurrentUser();
  const info = useFuturesSymbolInfo(symbol);
  const ticker = useFuturesTicker(symbol);
  const markPrice = useFuturesMarkPrice(symbol);
  const balances = useFuturesBalances();
  const positions = useFuturesPositions();
  const orderMut = useCreateFuturesOrder();

  const { tab, switchTab, error, flash, clearStatus, numericHandler, submitGuarded } =
    useOrderFormState<TabKey>("limit");
  const [price, setPrice] = useState("");
  const [stop, setStop] = useState("");
  const [qty, setQty] = useState("");
  const [tif, setTif] = useState<TimeInForce>("GTC");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [levOpen, setLevOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);

  const position = positions.data?.find((p) => p.symbol === symbol) ?? null;
  const leverage = position?.leverage ?? DEFAULT_LEVERAGE;
  const marginMode: MarginMode = position?.marginMode ?? "ISOLATED";

  const base = info?.baseAsset ?? "—";
  const quote = info?.quoteAsset ?? "—";
  const avail = info
    ? balances.data?.find((b) => b.asset === info.quoteAsset)?.free ?? null
    : null;
  const pending = orderMut.isPending;

  // 트리거(mark)까지 BE 보관하는 stop류
  const isStopTab = tab === "stop-limit" || tab === "stop-market";
  // 가격 입력 노출 = limit-like (체결 시 가격이 있는 타입)
  const needsPrice = tab === "limit" || tab === "post-only" || tab === "stop-limit";
  const needsStop = tab === "stop-limit" || tab === "stop-market";

  // 표시용 근사 — market-like는 mark(없으면 last) 기준. 정확한 검증/잠금은 BE
  const refPrice = !needsPrice
    ? markPrice?.markPrice ?? ticker?.lastPrice ?? null
    : isPos(price)
      ? price
      : null;
  const cost = useMemo(() => {
    if (reduceOnly) return "0.00"; // reduceOnly는 잠금 없음
    if (!refPrice || !isPos(qty) || leverage < 1) return null;
    const v = (Number(refPrice) * Number(qty)) / leverage;
    return Number.isFinite(v) ? v.toFixed(2) : null;
  }, [reduceOnly, refPrice, qty, leverage]);

  const handlePrice = numericHandler(setPrice);
  const handleStop = numericHandler(setStop);
  const handleQty = numericHandler(setQty);

  // stop 방향: stop이 ref(mark/last) 위면 BUY=손절·SELL=익절. ref 미상이면 손절 가정.
  function resolveStopType(side: OrderSide): FuturesOrderType {
    const s = Number(stop);
    const ref = markPrice?.markPrice ?? ticker?.lastPrice ?? null;
    const refNum = ref != null ? Number(ref) : null;
    const stopLoss = refNum == null ? true : side === "BUY" ? s > refNum : s < refNum;
    if (tab === "stop-market") return stopLoss ? "STOP_LOSS" : "TAKE_PROFIT";
    return stopLoss ? "STOP_LOSS_LIMIT" : "TAKE_PROFIT_LIMIT";
  }

  function validate(): string | null {
    if (!info) return t("futures.orderForm.err.noInfo");
    if (needsPrice) {
      if (!isPos(price)) return t("futures.orderForm.err.price");
      if (decimalsOf(price) > info.pricePrecision)
        return t("futures.orderForm.err.priceDecimals", { n: info.pricePrecision });
    }
    if (needsStop) {
      if (!isPos(stop)) return t("futures.orderForm.err.stop");
      if (decimalsOf(stop) > info.pricePrecision)
        return t("futures.orderForm.err.stopDecimals", { n: info.pricePrecision });
    }
    if (!isPos(qty)) return t("futures.orderForm.err.qty");
    if (decimalsOf(qty) > info.qtyPrecision)
      return t("futures.orderForm.err.qtyDecimals", { n: info.qtyPrecision });

    const minNotional = Number(info.minNotional);
    if (minNotional > 0 && refPrice !== null) {
      // mark/last 미형성 시 생략 — BE가 최종 검증
      const notional = Number(refPrice) * Number(qty);
      if (notional < minNotional)
        return t("futures.orderForm.err.minNotional", { min: info.minNotional, asset: info.quoteAsset });
    }
    return null;
  }

  async function submit(side: OrderSide) {
    const q = normDecimal(qty);
    const s = normDecimal(stop);
    const p = normDecimal(price);
    let req: CreateFuturesOrderReq;
    if (tab === "market") {
      req = { symbol, type: "MARKET", side, timeInForce: "IOC", qty: q, reduceOnly };
    } else if (tab === "stop-market") {
      req = { symbol, type: resolveStopType(side), side, timeInForce: "IOC", stopPrice: s, qty: q, reduceOnly };
    } else if (tab === "stop-limit") {
      req = { symbol, type: resolveStopType(side), side, timeInForce: tif, price: p, stopPrice: s, qty: q, reduceOnly };
    } else {
      req = {
        symbol,
        type: tab === "post-only" ? "POST_ONLY" : "LIMIT",
        side,
        timeInForce: tab === "post-only" ? "GTC" : tif,
        price: p,
        qty: q,
        reduceOnly,
      };
    }
    await submitGuarded(validate, async () => {
      await orderMut.mutateAsync(req);
      setPrice("");
      setStop("");
      setQty("");
    });
  }

  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="grid grid-cols-2 gap-1 p-2 border-b border-line shrink-0">
        <button
          type="button"
          onClick={() => setModeOpen(true)}
          disabled={!info}
          title={t("futures.orderForm.marginMode")}
          className="h-7 inline-flex items-center justify-center text-[11px] bg-raised border border-line text-text hover:border-line-strong disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {marginMode === "CROSS" ? t("futures.orderForm.cross") : t("futures.orderForm.isolated")}
        </button>
        <button
          type="button"
          onClick={() => setLevOpen(true)}
          disabled={!info}
          className="h-7 inline-flex items-center justify-center text-[11px] bg-raised border border-line text-text tnum hover:border-line-strong disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {leverage}x
        </button>
      </div>

      <FormTabs
        tabs={TABS.map((tb) => ({ key: tb.key, label: t(tb.labelKey) }))}
        active={tab}
        onSelect={switchTab}
      />

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2.5">
        <InfoRow label={t("futures.orderForm.avail")} value={avail ?? "—"} unit={quote} />

        {needsStop && (
          <LabeledInput
            label={t("futures.orderForm.stop")}
            suffix={quote}
            value={stop}
            onChange={(e) => handleStop(e.target.value)}
            placeholder="0"
            inputMode="decimal"
          />
        )}

        {!needsPrice ? (
          <LabeledInput label={t("futures.orderForm.price")} suffix={quote} value={t("futures.orderForm.market")} disabled readOnly />
        ) : (
          <LabeledInput
            label={t("futures.orderForm.price")}
            suffix={quote}
            value={price}
            onChange={(e) => handlePrice(e.target.value)}
            placeholder="0"
            inputMode="decimal"
          />
        )}

        <LabeledInput
          label={t("futures.orderForm.qty")}
          suffix={base}
          value={qty}
          onChange={(e) => handleQty(e.target.value)}
          placeholder="0"
          inputMode="decimal"
        />

        {(tab === "limit" || tab === "stop-limit") && (
          <TifSelector
            options={TIF_OPTIONS}
            value={tif}
            onChange={(t) => {
              setTif(t);
              clearStatus();
            }}
          />
        )}

        {isStopTab && (
          <p className="text-[10px] text-text-muted">
            {t("futures.orderForm.stopHint")}
          </p>
        )}

        <CheckboxRow
          label={t("futures.orderForm.reduceOnly")}
          checked={reduceOnly}
          onChange={(v) => {
            setReduceOnly(v);
            clearStatus();
          }}
        />

        <InfoRow label={t("futures.orderForm.cost")} value={cost !== null ? `≈ ${cost}` : "—"} unit={quote} />

        <StatusMessages error={error} flash={flash} />

        {user === null ? (
          <GuestCta />
        ) : (
          <div className="grid grid-cols-2 gap-2 mt-1">
            <Button
              variant="buy"
              disabled={pending || user === undefined || !info}
              onClick={() => void submit("BUY")}
            >
              {t("futures.orderForm.buyLong")}
            </Button>
            <Button
              variant="sell"
              disabled={pending || user === undefined || !info}
              onClick={() => void submit("SELL")}
            >
              {t("futures.orderForm.sellShort")}
            </Button>
          </div>
        )}
      </div>

      {levOpen && info && (
        <LeverageDialog
          symbol={symbol}
          current={leverage}
          maxLeverage={info.maxLeverage}
          marginMode={marginMode}
          onClose={() => setLevOpen(false)}
        />
      )}

      {modeOpen && info && (
        <MarginModeDialog
          symbol={symbol}
          current={marginMode}
          onClose={() => setModeOpen(false)}
        />
      )}
    </div>
  );
}
