"use client";

import { OrderBookPanel } from "@/components/common/order-book";
import {
  useFuturesDepth,
  useFuturesMarkPrice,
  useFuturesTicker,
} from "@/lib/hooks/use-futures-market";
import { useT } from "@/lib/i18n/provider";

/** fmarket 스트림, 스프레드 대신 mark 표시. */
export function FuturesOrderBook({ symbol }: { symbol: string }) {
  const t = useT();
  const depth = useFuturesDepth(symbol);
  const ticker = useFuturesTicker(symbol);
  const markPrice = useFuturesMarkPrice(symbol);

  return (
    <OrderBookPanel
      depth={depth}
      ticker={ticker}
      header={<span className="text-[13px] font-medium text-text">{t("futures.orderBook.title")}</span>}
      midRight={() => (
        <span className="text-[11px] text-text-dim tnum">
          {t("futures.orderBook.mark")} {markPrice?.markPrice ?? "—"}
        </span>
      )}
    />
  );
}
