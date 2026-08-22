"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Kline } from "@/lib/types/market";
import { useT } from "@/lib/i18n/provider";

const UP = "#0ecb81";
const DOWN = "#f6465d";
const GRID = "#2b3139";
const AXIS_TEXT = "#848e9c";
const VOL_UP = "#0ecb8166";
const VOL_DOWN = "#f6465d66";

const DEFAULT_INTERVAL = "1h";

/** 시장별 데이터 소스 — 훅을 모듈 레벨 상수 객체로 주입 (렌더 간 동일 참조 필수). */
export interface ChartDataSource {
  useExchangeInfo(): { intervals: string[] | undefined; isError: boolean };
  useSymbolInfo(symbol: string): { pricePrecision: number; tickSize: string } | null;
  useKlines(symbol: string, interval: string | null): Kline[] | null;
}

function toTime(openTimeMs: number): UTCTimestamp {
  return Math.floor(openTimeMs / 1000) as UTCTimestamp;
}

function toCandle(k: Kline): CandlestickData<UTCTimestamp> {
  return {
    time: toTime(k.openTime),
    open: Number(k.open),
    high: Number(k.high),
    low: Number(k.low),
    close: Number(k.close),
  };
}

function toVolume(k: Kline): HistogramData<UTCTimestamp> {
  return {
    time: toTime(k.openTime),
    value: Number(k.volume),
    color: Number(k.close) >= Number(k.open) ? VOL_UP : VOL_DOWN,
  };
}

type KlineDelta = { kind: "none" } | { kind: "last"; bar: Kline } | { kind: "full" };

/** 이전 배열 대비 변경 분류 — 마지막 캔들 갱신/추가만이면 series.update, 그 외 setData. */
function classifyDelta(prev: Kline[], next: Kline[]): KlineDelta {
  if (prev === next) return { kind: "none" };
  if (prev.length === 0 || next.length === 0) return { kind: "full" };
  const appended = next.length === prev.length + 1;
  if (!appended && next.length !== prev.length) return { kind: "full" };
  const sharedLen = appended ? prev.length : prev.length - 1;
  for (let i = 0; i < sharedLen; i++) {
    if (next[i] !== prev[i]) return { kind: "full" };
  }
  const nextLast = next[next.length - 1];
  const prevLast = prev[prev.length - 1];
  if (appended) {
    // update()는 신규 바 추가 시 시간이 단조 증가해야 한다
    if (nextLast.openTime > prevLast.openTime) return { kind: "last", bar: nextLast };
    return { kind: "full" };
  }
  if (nextLast === prevLast) return { kind: "none" };
  if (nextLast.openTime === prevLast.openTime) return { kind: "last", bar: nextLast };
  return { kind: "full" };
}

export function BaseChartPanel({ symbol, source }: { symbol: string; source: ChartDataSource }) {
  const t = useT();
  const { intervals, isError: exchangeInfoError } = source.useExchangeInfo();
  const symbolInfo = source.useSymbolInfo(symbol);

  // 유저 선택이 없으면 초기 선택은 1h(있을 때) 또는 첫 인터벌
  const [userInterval, setUserInterval] = useState<string | null>(null);
  const selectedInterval =
    userInterval ??
    (intervals && intervals.length > 0
      ? intervals.includes(DEFAULT_INTERVAL)
        ? DEFAULT_INTERVAL
        : intervals[0]
      : null);

  const klines = source.useKlines(symbol, selectedInterval);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const appliedRef = useRef<{ key: string; list: Kline[] } | null>(null);

  // 차트 생성/파괴 (마운트 1회)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const fontFamily = getComputedStyle(container)
      .getPropertyValue("--font-mono")
      .trim();

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: AXIS_TEXT,
        fontSize: 11,
        ...(fontFamily ? { fontFamily } : {}),
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      rightPriceScale: { borderColor: GRID },
      timeScale: {
        borderColor: GRID,
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    candle.priceScale().applyOptions({
      scaleMargins: { top: 0.08, bottom: 0.28 },
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume", // 오버레이 스케일 — 하단 영역에 분리
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candle;
    volumeSeriesRef.current = volume;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) chart.applyOptions({ width, height });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      appliedRef.current = null;
      chart.remove();
    };
  }, []);

  // 가격축 포맷 — ticker precision
  useEffect(() => {
    const candle = candleSeriesRef.current;
    if (!candle || !symbolInfo) return;
    candle.applyOptions({
      priceFormat: {
        type: "price",
        precision: symbolInfo.pricePrecision,
        minMove: Number(symbolInfo.tickSize),
      },
    });
  }, [symbolInfo]);

  // 데이터 반영 — 마지막 캔들은 update, 전체 변경은 setData
  useEffect(() => {
    const candle = candleSeriesRef.current;
    const volume = volumeSeriesRef.current;
    if (!candle || !volume) return;

    if (!klines) {
      if (appliedRef.current) {
        candle.setData([]);
        volume.setData([]);
        appliedRef.current = null;
      }
      return;
    }

    const key = `${symbol}:${selectedInterval}`;
    const prev = appliedRef.current;
    const delta: KlineDelta =
      prev && prev.key === key ? classifyDelta(prev.list, klines) : { kind: "full" };

    if (delta.kind === "last") {
      candle.update(toCandle(delta.bar));
      volume.update(toVolume(delta.bar));
    } else if (delta.kind === "full") {
      candle.setData(klines.map(toCandle));
      volume.setData(klines.map(toVolume));
    }
    appliedRef.current = { key, list: klines };
  }, [klines, symbol, selectedInterval]);

  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="flex items-center border-b border-line h-9 shrink-0">
        <div className="flex items-center h-full px-3 border-r border-line shrink-0">
          <span className="text-[12px] text-text font-medium">{t("widgets.chart.title")}</span>
        </div>
        <div className="flex items-center h-full min-w-0 overflow-x-auto">
          {intervals ? (
            intervals.map((interval) => (
              <button
                key={interval}
                onClick={() => setUserInterval(interval)}
                className={`px-2.5 h-full text-[12px] tnum shrink-0 ${
                  interval === selectedInterval
                    ? "text-text font-medium"
                    : "text-text-dim hover:text-text"
                }`}
              >
                {interval}
              </button>
            ))
          ) : (
            <span className="px-2.5 text-[12px] text-text-dim">
              {exchangeInfoError
                ? t("widgets.chart.intervalsError")
                : t("widgets.chart.loadingIntervals")}
            </span>
          )}
        </div>
        <div className="flex-1" />
      </div>
      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className="absolute inset-0" />
        {!klines && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <span className="text-[12px] text-text-muted">{t("widgets.chart.loadingChart")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
