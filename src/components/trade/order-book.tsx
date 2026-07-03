"use client";

import { OrderBookPanel } from "@/components/common/order-book";
import { useDepth, useTicker } from "@/lib/hooks/use-market";
import { useT } from "@/lib/i18n/provider";

export function OrderBook({ symbol }: { symbol: string }) {
  const t = useT();
  const depth = useDepth(symbol);
  const ticker = useTicker(symbol);

  return (
    <OrderBookPanel
      depth={depth}
      ticker={ticker}
      header={
        <>
          <button className="text-[13px] font-medium text-text h-9 mr-4">{t("trade.orderBook.title")}</button>
          <button className="text-[13px] text-text-dim hover:text-text h-9">{t("trade.orderBook.trades")}</button>
        </>
      }
      midRight={({ askPrice, bidPrice }) => {
        const spread =
          askPrice !== null && bidPrice !== null
            ? (Number(askPrice) - Number(bidPrice)).toFixed(ticker?.pricePrecision ?? 2)
            : null;
        return (
          <span className="text-[11px] text-text-dim">
            {t("trade.orderBook.spread", { value: spread ?? "—" })}
          </span>
        );
      }}
    />
  );
}
