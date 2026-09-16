"use client";

import { useMemo } from "react";
import { flyColor } from "./fly-sprite";
import type { FlyStanding } from "@/lib/types/fly";

const W = 800;
const H = 220;
const PAD = { l: 44, r: 70, t: 10, b: 20 };

/** 시즌 손익 곡선 — 파리마다 한 줄 (equity/시즌 시작 equity − 1, %). 색은 아레나·스프라이트와 같다. */
export function FlyPnlChart({ table, seasonStartedAt, selected, emptyHint }: { table: FlyStanding[]; seasonStartedAt: number; selected: number | null; emptyHint: string }) {
  const series = useMemo(
    () =>
      table
        .map((r) => ({
          slot: r.slot,
          id: r.id,
          pts: r.sparkline.filter((p) => p.t >= seasonStartedAt).map((p) => ({ t: p.t, v: r.seasonStartEquity > 0 ? (p.equity / r.seasonStartEquity - 1) * 100 : 0 })),
        }))
        .filter((s) => s.pts.length >= 2),
    [table, seasonStartedAt],
  );
  if (!series.length) {
    return (
      <div className="h-[220px] grid place-items-center">
        <p className="text-[12px] text-text-muted">{emptyHint}</p>
      </div>
    );
  }
  const t0 = Math.min(...series.map((s) => s.pts[0]!.t));
  const t1 = Math.max(...series.map((s) => s.pts[s.pts.length - 1]!.t), t0 + 60_000);
  const vals = series.flatMap((s) => s.pts.map((p) => p.v));
  const lim = Math.max(0.05, ...vals.map(Math.abs)) * 1.1;
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v + lim) / (2 * lim)) * (H - PAD.t - PAD.b);
  const ticks = [-lim, -lim / 2, 0, lim / 2, lim];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="season pnl chart" className="block">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "#474d57" : "#2b3139"} strokeDasharray={v === 0 ? undefined : "3 4"} />
          <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="#5e6673" className="tnum">
            {v >= 0 ? "+" : ""}
            {v.toFixed(2)}%
          </text>
        </g>
      ))}
      {series.map((s) => {
        const d = s.pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
        const last = s.pts[s.pts.length - 1]!;
        const dim = selected !== null && selected !== s.slot;
        return (
          <g key={s.slot} opacity={dim ? 0.25 : 1}>
            <path d={d} fill="none" stroke={flyColor(s.id, 60)} strokeWidth={selected === s.slot ? 2.5 : 1.5} strokeLinejoin="round" />
            <circle cx={x(last.t)} cy={y(last.v)} r="2.5" fill={flyColor(s.id, 60)} />
            <text x={x(last.t) + 6} y={y(last.v) + 3} fontSize="10" fill={flyColor(s.id, 65)} className="tnum">
              {s.id} {last.v >= 0 ? "+" : ""}
              {last.v.toFixed(2)}%
            </text>
          </g>
        );
      })}
      <text x={PAD.l} y={H - 6} fontSize="10" fill="#5e6673">
        {new Date(t0).toLocaleTimeString()}
      </text>
      <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize="10" fill="#5e6673">
        {new Date(t1).toLocaleTimeString()}
      </text>
    </svg>
  );
}
