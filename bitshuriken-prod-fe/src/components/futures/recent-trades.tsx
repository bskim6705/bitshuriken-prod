"use client";

import { RecentTradesPanel } from "@/components/common/recent-trades";
import { useFuturesTicker, useFuturesTrades } from "@/lib/hooks/use-futures-market";

/** fmarket 스트림. */
export function FuturesRecentTrades({ symbol }: { symbol: string }) {
  const trades = useFuturesTrades(symbol, 50);
  const ticker = useFuturesTicker(symbol);
  return <RecentTradesPanel trades={trades} ticker={ticker} />;
}
