"use client";

import { useMemo, type ReactNode } from "react";
import type { DepthSnapshot, Ticker24h } from "@/lib/types/market";
import { priceTone } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";

const ROWS_PER_SIDE = 12;

interface Level {
  price: string;
  qty: string;
  total: number; // cumulative qty
  ratio: number; // 0..1 relative to max total
}

function accumulate(levels: [string, string][], limit: number): Level[] {
  const sliced = levels.slice(0, limit);
  let cum = 0;
  const rows = sliced.map(([price, qty]) => {
    const q = Number(qty);
    cum += Number.isFinite(q) ? q : 0;
    return { price, qty, total: cum, ratio: 0 };
  });
  const max = rows.length ? rows[rows.length - 1].total : 0;
  if (max > 0) {
    for (const r of rows) r.ratio = r.total / max;
  }
  return rows;
}

function SideRows({
  rows,
  tone,
  qtyPrecision,
}: {
  rows: Level[];
  tone: "up" | "down";
  qtyPrecision: number;
}) {
  // 항상 ROWS_PER_SIDE 행을 그려 호가 깊이가 얕거나 비어도 패널 높이가 일정하게
  // 유지된다. 실제 호가는 mid 가격행에 인접하고, 부족분은 placeholder가 바깥쪽을
  // 채운다(asks는 flex-col-reverse라 둘 다 데이터 뒤에 붙이면 바깥쪽으로 간다).
  return (
    <>
      {Array.from({ length: ROWS_PER_SIDE }).map((_, i) => {
        const row = rows[i];
        if (!row) {
          return (
            <div
              key={`${tone}-empty-${i}`}
              className="grid grid-cols-3 px-3 h-[22px] shrink-0 items-center text-[12px] tnum text-text-muted"
            >
              <span>—</span>
              <span className="text-right">—</span>
              <span className="text-right">—</span>
            </div>
          );
        }
        return (
          <div
            key={`${tone}-${i}`}
            className="relative grid grid-cols-3 px-3 h-[22px] shrink-0 items-center text-[12px] tnum hover:bg-raised/50"
          >
            <div
              className={`absolute inset-y-0 right-0 ${tone === "up" ? "bg-up/15" : "bg-down/15"}`}
              style={{ width: `${(row.ratio * 100).toFixed(2)}%` }}
            />
            <span className={`relative ${tone === "up" ? "text-up" : "text-down"}`}>
              {row.price}
            </span>
            <span className="relative text-right text-text">{row.qty}</span>
            <span className="relative text-right text-text-dim">
              {row.total.toFixed(qtyPrecision)}
            </span>
          </div>
        );
      })}
    </>
  );
}

/** 시장별 차이는 헤더 내용 + 중앙 행 우측(spread/mark)만 — 주입으로 처리. */
export function OrderBookPanel({
  depth,
  ticker,
  header,
  midRight,
}: {
  depth: DepthSnapshot | null;
  ticker: Ticker24h | null;
  header: ReactNode;
  /** 중앙 가격 행 우측 — best ask/bid를 인자로 (spot spread 계산용). */
  midRight: (top: { askPrice: string | null; bidPrice: string | null }) => ReactNode;
}) {
  const t = useT();
  const asks = useMemo(
    () => accumulate(depth?.asks ?? [], ROWS_PER_SIDE),
    [depth],
  );
  const bids = useMemo(
    () => accumulate(depth?.bids ?? [], ROWS_PER_SIDE),
    [depth],
  );

  const midTone = priceTone(ticker?.priceChangePct24h ?? null);
  const midCls =
    midTone === "up" ? "text-up" : midTone === "down" ? "text-down" : "text-text";

  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="flex items-center border-b border-line h-9 px-3 shrink-0">{header}</div>
      <div className="grid grid-cols-3 px-3 py-1 text-[11px] text-text-dim border-b border-line shrink-0">
        <span>{t("widgets.orderBook.priceWithUnit", { unit: ticker?.quoteAsset ?? "—" })}</span>
        <span className="text-right">{t("widgets.orderBook.qtyWithUnit", { unit: ticker?.baseAsset ?? "—" })}</span>
        <span className="text-right">{t("common.total")}</span>
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 flex flex-col-reverse overflow-hidden">
          <SideRows rows={asks} tone="down" qtyPrecision={ticker?.qtyPrecision ?? 2} />
        </div>

        <div className="border-y border-line px-3 py-2 flex items-baseline justify-between shrink-0 bg-bg">
          <span className={`text-[16px] font-semibold tnum ${midCls}`}>
            {ticker?.lastPrice ?? "—"}
          </span>
          {midRight({
            askPrice: asks[0]?.price ?? null,
            bidPrice: bids[0]?.price ?? null,
          })}
        </div>

        <div className="flex-1 overflow-hidden">
          <SideRows rows={bids} tone="up" qtyPrecision={ticker?.qtyPrecision ?? 2} />
        </div>
      </div>
    </div>
  );
}
