"use client";

import { BaseChartPanel, type ChartDataSource } from "@/components/common/chart-panel";
import { useExchangeInfo, useKlines, useSymbolInfo } from "@/lib/hooks/use-market";

// spot: kline 스트림 머지 (REST 초기 로드 + WS)
const spotChartSource: ChartDataSource = {
  useExchangeInfo() {
    const { data, isError } = useExchangeInfo();
    return { intervals: data?.klineIntervals, isError };
  },
  useSymbolInfo,
  useKlines,
};

export function ChartPanel({ symbol }: { symbol: string }) {
  return <BaseChartPanel symbol={symbol} source={spotChartSource} />;
}
