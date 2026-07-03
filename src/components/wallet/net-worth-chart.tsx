"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  ColorType,
  LineSeries,
  createChart,
  type AreaData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import type { NetWorthPoint } from "@/lib/types/net-worth";
import { useT } from "@/lib/i18n/provider";

const ACCENT = "#fcd535";
const UP = "#0ecb81";
const DOWN = "#f6465d";
const GRID = "#2b3139";
const AXIS_TEXT = "#848e9c";

type Overlay = "total" | "split";

function toTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

function toLine(points: NetWorthPoint[], pick: (p: NetWorthPoint) => string): LineData<UTCTimestamp>[] {
  return points.map((p) => ({ time: toTime(p.time), value: Number(pick(p)) }));
}

function toArea(points: NetWorthPoint[]): AreaData<UTCTimestamp>[] {
  return points.map((p) => ({ time: toTime(p.time), value: Number(p.totalUsdt) }));
}

export function NetWorthChart({
  points,
  loading,
  signedOut,
  error,
}: {
  points: NetWorthPoint[] | undefined;
  loading: boolean;
  signedOut: boolean;
  error: boolean;
}) {
  const t = useT();
  const [overlay, setOverlay] = useState<Overlay>("total");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const totalSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const spotSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const futuresSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  // 차트 생성/파괴 (마운트 1회)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const fontFamily = getComputedStyle(container).getPropertyValue("--font-mono").trim();

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
        timeVisible: false,
        secondsVisible: false,
      },
      crosshair: { horzLine: { labelVisible: true }, vertLine: { labelVisible: true } },
    });

    const total = chart.addSeries(AreaSeries, {
      lineColor: ACCENT,
      topColor: "#fcd53533",
      bottomColor: "#fcd53500",
      lineWidth: 2,
      priceLineVisible: false,
    });
    const spot = chart.addSeries(LineSeries, {
      color: UP,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const futures = chart.addSeries(LineSeries, {
      color: DOWN,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chartRef.current = chart;
    totalSeriesRef.current = total;
    spotSeriesRef.current = spot;
    futuresSeriesRef.current = futures;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) chart.applyOptions({ width, height });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chartRef.current = null;
      totalSeriesRef.current = null;
      spotSeriesRef.current = null;
      futuresSeriesRef.current = null;
      chart.remove();
    };
  }, []);

  const data = useMemo(() => points ?? [], [points]);

  // 데이터 반영
  useEffect(() => {
    const total = totalSeriesRef.current;
    const spot = spotSeriesRef.current;
    const futures = futuresSeriesRef.current;
    const chart = chartRef.current;
    if (!total || !spot || !futures || !chart) return;

    total.setData(toArea(data));
    spot.setData(toLine(data, (p) => p.spotUsdt));
    futures.setData(toLine(data, (p) => p.futuresUsdt));
    if (data.length > 0) chart.timeScale().fitContent();
  }, [data]);

  // total / split 토글 — split일 때만 spot·futures 선 노출
  useEffect(() => {
    const spot = spotSeriesRef.current;
    const futures = futuresSeriesRef.current;
    if (!spot || !futures) return;
    const visible = overlay === "split";
    spot.applyOptions({ visible });
    futures.applyOptions({ visible });
  }, [overlay]);

  const empty = useMemo(() => !loading && !signedOut && !error && data.length === 0, [
    loading,
    signedOut,
    error,
    data.length,
  ]);

  return (
    <div className="bg-surface border border-line">
      <div className="flex items-center justify-between border-b border-line h-9 px-3">
        <span className="text-[12px] text-text font-medium">{t("wallet.netWorth.title")}</span>
        <div className="flex items-center gap-1">
          {(["total", "split"] as Overlay[]).map((o) => (
            <button
              key={o}
              onClick={() => setOverlay(o)}
              className={`h-6 px-2 text-[11px] border ${
                o === overlay
                  ? "border-accent text-accent"
                  : "border-line text-text-dim hover:text-text"
              }`}
            >
              {o === "total" ? t("wallet.netWorth.total") : t("wallet.netWorth.breakdown")}
            </button>
          ))}
        </div>
      </div>
      <div className="relative h-[220px]">
        <div ref={containerRef} className="absolute inset-0" />
        {(loading || signedOut || error || empty) && (
          <div className="absolute inset-0 grid place-items-center bg-surface">
            <span className="text-[12px] text-text-muted">
              {signedOut
                ? t("wallet.netWorth.loginToView")
                : error
                ? t("wallet.netWorth.failedLoad")
                : loading
                ? t("common.loading")
                : t("wallet.netWorth.noData")}
            </span>
          </div>
        )}
      </div>
      {overlay === "split" && !loading && !signedOut && !error && !empty && (
        <div className="flex items-center gap-4 border-t border-line px-3 py-1.5 text-[11px]">
          <span className="flex items-center gap-1.5 text-text-dim">
            <span className="inline-block w-2.5 h-0.5" style={{ background: ACCENT }} />{" "}
            {t("wallet.netWorth.legendTotal")}
          </span>
          <span className="flex items-center gap-1.5 text-text-dim">
            <span className="inline-block w-2.5 h-0.5" style={{ background: UP }} />{" "}
            {t("wallet.netWorth.legendSpot")}
          </span>
          <span className="flex items-center gap-1.5 text-text-dim">
            <span className="inline-block w-2.5 h-0.5" style={{ background: DOWN }} />{" "}
            {t("wallet.netWorth.legendFutures")}
          </span>
        </div>
      )}
    </div>
  );
}
