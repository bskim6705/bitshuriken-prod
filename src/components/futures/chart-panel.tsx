"use client";

import { BaseChartPanel, type ChartDataSource } from "@/components/common/chart-panel";
import {
  useFuturesExchangeInfo,
  useFuturesKlines,
  useFuturesSymbolInfo,
} from "@/lib/hooks/use-futures-market";

// futures: kline 스트림 머지 (REST 초기 로드 + WS)
const futuresChartSource: ChartDataSource = {
  useExchangeInfo() {
    const { data, isError } = useFuturesExchangeInfo();
    return { intervals: data?.klineIntervals, isError };
  },
  useSymbolInfo: useFuturesSymbolInfo,
  useKlines: useFuturesKlines,
};

export function FuturesChartPanel({ symbol }: { symbol: string }) {
  return <BaseChartPanel symbol={symbol} source={futuresChartSource} />;
}
