"use client";

import { useMemo, useRef, useState } from "react";
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
import { useExchangeInfo, useSymbolInfo, useTicker } from "@/lib/hooks/use-market";
import {
  isPos,
  normDecimal,
  decimalsOf,
  useOrderFormState,
  NUMERIC_RE,
} from "@/lib/hooks/use-order-form-state";
import {
  useBalances,
  useCommission,
  useCreateOco,
  useCreateOrder,
} from "@/lib/hooks/use-trading";
import type { OrderSide } from "@/lib/types/market";
import type { CreateOrderReq, OrderType, TimeInForce } from "@/lib/types/trading";
import { useT } from "@/lib/i18n/provider";
import type { TranslationKey } from "@/lib/i18n/messages";

type TabKey = "limit" | "market" | "stop-limit" | "stop-market" | "oco";

// 탭 노출 조건: exchange-info orderTypes 보유 여부 (OCO는 양 레그 타입 모두 + ocoAllowed)
// labelKey는 렌더 시 t()로 해석 (훅은 모듈 레벨 호출 불가).
const TAB_DEFS: { key: TabKey; labelKey: TranslationKey; types: OrderType[]; all?: boolean }[] = [
  { key: "limit", labelKey: "trade.orderForm.limit", types: ["LIMIT"] },
  { key: "market", labelKey: "trade.orderForm.market", types: ["MARKET"] },
  { key: "stop-limit", labelKey: "trade.orderForm.stopLimit", types: ["STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"] },
  { key: "stop-market", labelKey: "trade.orderForm.stopMarket", types: ["STOP_LOSS", "TAKE_PROFIT"] },
  { key: "oco", labelKey: "trade.orderForm.oco", types: ["LIMIT", "STOP_LOSS_LIMIT"], all: true },
];

const PCT_OPTIONS = [0.25, 0.5, 0.75, 1] as const;

// 환산은 10^8 스케일 BigInt로 수행 — float 왕복 없이 floor 보장
const SCALE = 8;
const SCALE_FACTOR = BigInt(10) ** BigInt(SCALE);

/** 십진 문자열 → 10^8 스케일 BigInt. 파싱 불가 시 null. */
function toScaled(v: string): bigint | null {
  if (v === "" || v === "." || !NUMERIC_RE.test(v)) return null;
  const [int, frac = ""] = v.split(".");
  return BigInt(int || "0") * SCALE_FACTOR + BigInt((frac + "0".repeat(SCALE)).slice(0, SCALE));
}

/** 양수 스케일 값만 — 0 또는 파싱 불가 시 null. */
function toScaledPos(v: string): bigint | null {
  const s = toScaled(v);
  return s !== null && s > BigInt(0) ? s : null;
}

/** prec 자리로 내림 (10^8 스케일 유지). */
function floorScaled(s: bigint, prec: number): bigint {
  const f = BigInt(10) ** BigInt(SCALE - prec);
  return (s / f) * f;
}

/** 10^8 스케일 BigInt → prec 자리 내림 고정 소수 문자열. */
function formatScaled(s: bigint, prec: number): string {
  const str = floorScaled(s, prec).toString().padStart(SCALE + 1, "0");
  const int = str.slice(0, -SCALE);
  return prec > 0 ? `${int}.${str.slice(-SCALE).slice(0, prec)}` : int;
}

export function OrderForm({ symbol }: { symbol: string }) {
  const t = useT();
  const { data: user } = useCurrentUser();
  const exchange = useExchangeInfo();
  const info = useSymbolInfo(symbol);
  const ticker = useTicker(symbol);
  const balances = useBalances();
  const commission = useCommission();
  const orderMut = useCreateOrder();
  const ocoMut = useCreateOco();

  const {
    tab: tabKey,
    switchTab,
    error,
    flash,
    clearStatus,
    numericHandler,
    submitGuarded,
  } = useOrderFormState<TabKey>("limit");
  const [side, setSide] = useState<OrderSide>("BUY");
  const [price, setPrice] = useState("");
  const [stop, setStop] = useState("");
  const [stopLimit, setStopLimit] = useState("");
  const [qty, setQty] = useState("");
  const [total, setTotal] = useState("");
  const [tif, setTif] = useState<TimeInForce>("GTC");
  const [postOnly, setPostOnly] = useState(false);
  const lastEditedRef = useRef<"qty" | "total">("qty");

  const orderTypes = exchange.data?.orderTypes ?? [];
  const tifOptions = (exchange.data?.timeInForce ?? []) as TimeInForce[];

  const visibleTabs = useMemo(() => {
    const types = exchange.data?.orderTypes ?? [];
    return TAB_DEFS.filter((def) => {
      const has = def.all
        ? def.types.every((x) => types.includes(x))
        : def.types.some((x) => types.includes(x));
      if (def.key === "oco") return has && (info?.ocoAllowed ?? false);
      return has;
    }).map((def) => ({ key: def.key, label: t(def.labelKey) }));
  }, [exchange.data, info, t]);

  const activeTab: TabKey = visibleTabs.some((t) => t.key === tabKey)
    ? tabKey
    : (visibleTabs[0]?.key ?? "limit");

  const base = info?.baseAsset ?? "—";
  const quote = info?.quoteAsset ?? "—";
  const marketLike = activeTab === "market" || activeTab === "stop-market";
  const buyTotalOnly = marketLike && side === "BUY";
  const hasTotalSync = activeTab === "limit" || activeTab === "stop-limit";
  const lastPrice = ticker?.lastPrice != null ? Number(ticker.lastPrice) : null;
  const pending = orderMut.isPending || ocoMut.isPending;

  const showTif =
    tifOptions.length > 0 &&
    ((activeTab === "limit" && !postOnly) || activeTab === "stop-limit" || activeTab === "oco");
  const showPostOnly = activeTab === "limit" && orderTypes.includes("POST_ONLY");

  function freeOf(asset: string): string | null {
    return balances.data?.find((b) => b.asset === asset)?.free ?? null;
  }

  const availAsset = side === "BUY" ? quote : base;
  const avail = info ? freeOf(side === "BUY" ? info.quoteAsset : info.baseAsset) : null;

  function switchSide(next: OrderSide) {
    setSide(next);
    clearStatus();
  }

  // price/qty/total은 lastEditedRef 동기화 때문에 numericHandler 대신 직접 핸들러
  function handlePrice(v: string) {
    if (!NUMERIC_RE.test(v)) return;
    setPrice(v);
    clearStatus();
    if (!hasTotalSync || !info) return;
    const pS = toScaledPos(v);
    if (pS === null) return;
    if (lastEditedRef.current === "total") {
      const tS = toScaledPos(total);
      if (tS !== null) setQty(formatScaled((tS * SCALE_FACTOR) / pS, info.qtyPrecision));
    } else {
      const qS = toScaledPos(qty);
      if (qS !== null) setTotal(formatScaled((pS * qS) / SCALE_FACTOR, info.pricePrecision));
    }
  }

  function handleQty(v: string) {
    if (!NUMERIC_RE.test(v)) return;
    setQty(v);
    lastEditedRef.current = "qty";
    clearStatus();
    if (!hasTotalSync || !info) return;
    const qS = toScaledPos(v);
    const pS = toScaledPos(price);
    if (qS !== null && pS !== null) {
      setTotal(formatScaled((pS * qS) / SCALE_FACTOR, info.pricePrecision));
    } else {
      setTotal("");
    }
  }

  function handleTotal(v: string) {
    if (!NUMERIC_RE.test(v)) return;
    setTotal(v);
    lastEditedRef.current = "total";
    clearStatus();
    if (!hasTotalSync || !info) return;
    const tS = toScaledPos(v);
    const pS = toScaledPos(price);
    if (tS !== null && pS !== null) {
      setQty(formatScaled((tS * SCALE_FACTOR) / pS, info.qtyPrecision));
    } else {
      setQty("");
    }
  }

  const handleStop = numericHandler(setStop);
  const handleStopLimit = numericHandler(setStopLimit);

  function applyPercent(pct: number) {
    clearStatus();
    if (!info) return;
    const pctBig = BigInt(Math.round(pct * 100));
    const hundred = BigInt(100);
    if (side === "SELL") {
      const freeS = toScaled(freeOf(info.baseAsset) ?? "");
      if (freeS === null) return;
      const qS = floorScaled((freeS * pctBig) / hundred, info.qtyPrecision);
      setQty(formatScaled(qS, info.qtyPrecision));
      lastEditedRef.current = "qty";
      const pS = toScaledPos(price);
      if (hasTotalSync && pS !== null && qS > BigInt(0)) {
        setTotal(formatScaled((pS * qS) / SCALE_FACTOR, info.pricePrecision));
      }
      return;
    }
    const freeS = toScaled(freeOf(info.quoteAsset) ?? "");
    if (freeS === null) return;
    const quoteS = (freeS * pctBig) / hundred;
    if (marketLike) {
      setTotal(formatScaled(quoteS, info.pricePrecision));
      return;
    }
    if (activeTab === "oco") {
      // BUY 잠금 = max(price, stopLimitPrice) * qty 기준 역산
      const pS = toScaledPos(price) ?? BigInt(0);
      const slS = toScaledPos(stopLimit) ?? BigInt(0);
      const ref = pS > slS ? pS : slS;
      if (ref > BigInt(0)) setQty(formatScaled((quoteS * SCALE_FACTOR) / ref, info.qtyPrecision));
      return;
    }
    setTotal(formatScaled(quoteS, info.pricePrecision));
    lastEditedRef.current = "total";
    const pS = toScaledPos(price);
    if (pS !== null) setQty(formatScaled((quoteS * SCALE_FACTOR) / pS, info.qtyPrecision));
  }

  /** stop 방향 결정: last 대비 stop 위치. last 미상(체결 이력 전무)이면 stop-loss 방향. */
  function resolveStopType(): OrderType {
    const s = Number(stop);
    const stopLoss = lastPrice == null ? true : side === "BUY" ? s > lastPrice : s < lastPrice;
    if (activeTab === "stop-market") return stopLoss ? "STOP_LOSS" : "TAKE_PROFIT";
    return stopLoss ? "STOP_LOSS_LIMIT" : "TAKE_PROFIT_LIMIT";
  }

  function validate(): string | null {
    if (!info) return t("trade.orderForm.symbolNotLoaded");

    if (activeTab === "limit" || activeTab === "stop-limit" || activeTab === "oco") {
      if (!isPos(price)) return t("trade.orderForm.invalidPrice");
      if (decimalsOf(price) > info.pricePrecision)
        return t("trade.orderForm.priceDecimals", { n: info.pricePrecision });
    }
    if (activeTab === "stop-limit" || activeTab === "stop-market" || activeTab === "oco") {
      if (!isPos(stop)) return t("trade.orderForm.invalidStop");
      if (decimalsOf(stop) > info.pricePrecision)
        return t("trade.orderForm.stopDecimals", { n: info.pricePrecision });
    }
    if (activeTab === "oco") {
      if (!isPos(stopLimit)) return t("trade.orderForm.invalidStopLimit");
      if (decimalsOf(stopLimit) > info.pricePrecision)
        return t("trade.orderForm.stopLimitDecimals", { n: info.pricePrecision });
    }
    if (buyTotalOnly) {
      if (!isPos(total)) return t("trade.orderForm.invalidTotal");
      if (decimalsOf(total) > info.pricePrecision)
        return t("trade.orderForm.totalDecimals", { n: info.pricePrecision });
    } else {
      if (!isPos(qty)) return t("trade.orderForm.invalidQty");
      if (decimalsOf(qty) > info.qtyPrecision)
        return t("trade.orderForm.qtyDecimals", { n: info.qtyPrecision });
    }

    const minNotional = Number(info.minNotional);
    if (minNotional > 0) {
      let notional: number | null = null;
      if (buyTotalOnly) notional = Number(total);
      else if (marketLike) notional = lastPrice != null ? lastPrice * Number(qty) : null; // last 없으면 생략
      else if (activeTab === "oco") notional = Math.min(Number(price), Number(stopLimit)) * Number(qty);
      else notional = Number(price) * Number(qty);
      if (notional != null && notional < minNotional)
        return t("trade.orderForm.minNotional", { value: info.minNotional, asset: info.quoteAsset });
    }

    if (activeTab === "stop-limit" || activeTab === "stop-market") {
      const stopType = resolveStopType();
      if (!orderTypes.includes(stopType))
        return t("trade.orderForm.typeUnsupported", { type: stopType });
    }
    return null;
  }

  function buildOrderReq(): CreateOrderReq {
    const common = { tickerSymbol: symbol, tickerMarket: "SPOT" as const, side };
    const p = normDecimal(price);
    const s = normDecimal(stop);
    const q = normDecimal(qty);
    const t = normDecimal(total);
    if (activeTab === "limit") {
      // Post-Only는 GTC 고정 (TIF 선택 비노출)
      return {
        ...common,
        type: postOnly ? "POST_ONLY" : "LIMIT",
        timeInForce: postOnly ? "GTC" : tif,
        price: p,
        origQty: q,
      };
    }
    if (activeTab === "stop-limit") {
      return { ...common, type: resolveStopType(), timeInForce: tif, price: p, stopPrice: s, origQty: q };
    }
    // market류는 IOC 의미론 (DTO가 timeInForce 필수)
    if (activeTab === "stop-market") {
      return side === "BUY"
        ? { ...common, type: resolveStopType(), timeInForce: "IOC", stopPrice: s, origQuoteQty: t }
        : { ...common, type: resolveStopType(), timeInForce: "IOC", stopPrice: s, origQty: q };
    }
    return side === "BUY"
      ? { ...common, type: "MARKET", timeInForce: "IOC", origQuoteQty: t }
      : { ...common, type: "MARKET", timeInForce: "IOC", origQty: q };
  }

  async function submit() {
    await submitGuarded(validate, async () => {
      if (activeTab === "oco") {
        await ocoMut.mutateAsync({
          tickerSymbol: symbol,
          tickerMarket: "SPOT",
          side,
          qty: normDecimal(qty),
          price: normDecimal(price),
          stopPrice: normDecimal(stop),
          stopLimitPrice: normDecimal(stopLimit),
          stopLimitTimeInForce: tif,
        });
      } else {
        await orderMut.mutateAsync(buildOrderReq());
      }
      setPrice("");
      setStop("");
      setStopLimit("");
      setQty("");
      setTotal("");
    });
  }

  // Est. fee: taker 요율을 수령 자산 기준 notional에 적용 (BUY→base, SELL→quote)
  const fee = useMemo(() => {
    if (!info || !commission.data) return null;
    const taker = Number(commission.data.taker);
    if (side === "BUY") {
      const baseQty = marketLike
        ? isPos(total) && lastPrice != null
          ? Number(total) / lastPrice
          : null
        : isPos(qty)
          ? Number(qty)
          : null;
      if (baseQty == null) return null;
      return { value: (baseQty * taker).toFixed(8), asset: info.baseAsset };
    }
    const quoteAmt = marketLike
      ? isPos(qty) && lastPrice != null
        ? Number(qty) * lastPrice
        : null
      : isPos(qty) && isPos(price)
        ? Number(qty) * Number(price)
        : null;
    if (quoteAmt == null) return null;
    return { value: (quoteAmt * taker).toFixed(8), asset: info.quoteAsset };
  }, [info, commission.data, side, marketLike, total, qty, price, lastPrice]);

  const percentRow = (
    <div className="grid grid-cols-4 gap-1">
      {PCT_OPTIONS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => applyPercent(p)}
          className="h-7 text-[11px] text-text-dim hover:text-text border border-line bg-raised tnum"
        >
          {p * 100}%
        </button>
      ))}
    </div>
  );

  const qtyInput = (
    <LabeledInput
      label={t("trade.orderForm.qty")}
      suffix={base}
      value={qty}
      onChange={(e) => handleQty(e.target.value)}
      placeholder="0"
      inputMode="decimal"
    />
  );

  const totalInput = (
    <LabeledInput
      label={t("trade.orderForm.total")}
      suffix={quote}
      value={total}
      onChange={(e) => handleTotal(e.target.value)}
      placeholder="0"
      inputMode="decimal"
    />
  );

  const priceInput = (
    <LabeledInput
      label={t("trade.orderForm.price")}
      suffix={quote}
      value={price}
      onChange={(e) => handlePrice(e.target.value)}
      placeholder="0"
      inputMode="decimal"
    />
  );

  const stopInput = (
    <LabeledInput
      label={t("trade.orderForm.stop")}
      suffix={quote}
      value={stop}
      onChange={(e) => handleStop(e.target.value)}
      placeholder="0"
      inputMode="decimal"
    />
  );

  return (
    <div className="h-full flex flex-col bg-surface">
      <FormTabs tabs={visibleTabs} active={activeTab} onSelect={switchTab} />

      <div className="grid grid-cols-2 bg-bg border-b border-line shrink-0">
        <button
          type="button"
          onClick={() => switchSide("BUY")}
          className={`h-8 text-[12px] font-medium ${
            side === "BUY" ? "bg-up text-white" : "text-text-dim hover:text-text"
          }`}
        >
          {t("common.buy")}
        </button>
        <button
          type="button"
          onClick={() => switchSide("SELL")}
          className={`h-8 text-[12px] font-medium ${
            side === "SELL" ? "bg-down text-white" : "text-text-dim hover:text-text"
          }`}
        >
          {t("common.sell")}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2.5">
        <InfoRow label={t("trade.orderForm.avail")} value={avail ?? "—"} unit={availAsset} />

        {activeTab === "limit" && (
          <>
            {priceInput}
            {qtyInput}
            {percentRow}
            {totalInput}
          </>
        )}

        {activeTab === "market" && (
          <>
            <LabeledInput
              label={t("trade.orderForm.price")}
              suffix={quote}
              value={t("trade.orderForm.priceMarket")}
              disabled
              readOnly
            />
            {side === "BUY" ? totalInput : qtyInput}
            {percentRow}
          </>
        )}

        {activeTab === "stop-limit" && (
          <>
            {stopInput}
            {priceInput}
            {qtyInput}
            {percentRow}
            {totalInput}
          </>
        )}

        {activeTab === "stop-market" && (
          <>
            {stopInput}
            <LabeledInput
              label={t("trade.orderForm.price")}
              suffix={quote}
              value={t("trade.orderForm.priceMarket")}
              disabled
              readOnly
            />
            {side === "BUY" ? totalInput : qtyInput}
            {percentRow}
          </>
        )}

        {activeTab === "oco" && (
          <>
            {priceInput}
            {stopInput}
            <LabeledInput
              label={t("trade.orderForm.stopLimitPrice")}
              suffix={quote}
              value={stopLimit}
              onChange={(e) => handleStopLimit(e.target.value)}
              placeholder="0"
              inputMode="decimal"
            />
            {qtyInput}
            {percentRow}
          </>
        )}

        {showTif && (
          <TifSelector
            options={tifOptions}
            value={tif}
            onChange={(t) => {
              setTif(t);
              clearStatus();
            }}
          />
        )}

        {showPostOnly && (
          <CheckboxRow
            label={t("trade.orderForm.postOnly")}
            checked={postOnly}
            onChange={(v) => {
              setPostOnly(v);
              clearStatus();
            }}
          />
        )}

        <StatusMessages error={error} flash={flash} />

        {user === null ? (
          <GuestCta />
        ) : (
          <Button
            variant={side === "BUY" ? "buy" : "sell"}
            size="lg"
            className="mt-1"
            disabled={pending || user === undefined || !info}
            onClick={() => void submit()}
          >
            {side === "BUY"
              ? t("trade.orderForm.buyAsset", { asset: base })
              : t("trade.orderForm.sellAsset", { asset: base })}
          </Button>
        )}

        <div className="pt-2 mt-1 border-t border-line flex items-center justify-between text-[11px]">
          <span className="text-text-dim">{t("trade.orderForm.estFeeTaker")}</span>
          <span className="text-text tnum">{fee ? `${fee.value} ${fee.asset}` : "—"}</span>
        </div>
      </div>
    </div>
  );
}
