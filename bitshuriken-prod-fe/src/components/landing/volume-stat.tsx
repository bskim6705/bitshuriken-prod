"use client";

import { useMemo } from "react";
import { useAllTickers } from "@/lib/hooks/use-market";

function num(v: string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatShort(value: number): string {
  if (value === 0) return "$ 0";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$ ${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$ ${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$ ${(value / 1e3).toFixed(2)}K`;
  return `$ ${value.toFixed(2)}`;
}

export function VolumeStat() {
  const tickers = useAllTickers();
  const total = useMemo(() => {
    if (!tickers) return null;
    return tickers.reduce((acc, t) => acc + num(t.quoteVolume24h), 0);
  }, [tickers]);

  return (
    <p className="text-[20px] font-semibold tnum leading-tight mt-0.5">
      {total === null ? "$ —" : formatShort(total)}
    </p>
  );
}
