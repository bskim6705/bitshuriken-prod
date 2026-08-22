"use client";

import { RecentTradesPanel } from "@/components/common/recent-trades";
import { useTicker, useTrades } from "@/lib/hooks/use-market";

export function RecentTrades({ symbol }: { symbol: string }) {
  const trades = useTrades(symbol, 50);
  const ticker = useTicker(symbol);
  return <RecentTradesPanel trades={trades} ticker={ticker} />;
}
