"use client";

import { useMemo } from "react";
import { FlySprite, flyColor } from "./fly-sprite";
import type { FlyStanding } from "@/lib/types/fly";

const ROW = 46;
const W = 800;
const PAD_X = 120;

/**
 * 아레나 — 순위대로 한 줄씩, 가로 위치는 시즌 순수익(가운데 0, 오른쪽 이익). 강등 존 줄은 붉게 깔린다.
 * 파리 하나 = 스프라이트 + id + pnl 막대. 클릭하면 상세 선택.
 */
export function FlyArena({
  table,
  selected,
  onSelect,
  labels,
}: {
  table: FlyStanding[];
  selected: number | null;
  onSelect: (slot: number) => void;
  labels: { zero: string; relegation: string; inactive: string };
}) {
  const H = Math.max(ROW * table.length + 24, 120);
  const cx = W / 2;
  const maxAbs = useMemo(() => Math.max(0.1, ...table.map((r) => Math.abs(r.seasonPnlPct))), [table]);
  const x = (pnl: number) => cx + (pnl / maxAbs) * (cx - PAD_X);
  const firstRelegation = table.findIndex((r) => r.relegationZone);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="list" aria-label="fly arena" className="block">
      {firstRelegation >= 0 && (
        <g>
          <rect x="0" y={12 + firstRelegation * ROW} width={W} height={H - 12 - firstRelegation * ROW} fill="rgba(246,70,93,0.06)" />
          <line x1="0" x2={W} y1={12 + firstRelegation * ROW} y2={12 + firstRelegation * ROW} stroke="rgba(246,70,93,0.5)" strokeDasharray="4 4" />
          <text x={W - 8} y={12 + firstRelegation * ROW - 4} textAnchor="end" fontSize="10" fill="#f6465d">
            {labels.relegation}
          </text>
        </g>
      )}
      <line x1={cx} x2={cx} y1="6" y2={H - 6} stroke="#2b3139" />
      <text x={cx + 4} y={H - 8} fontSize="10" fill="#5e6673">
        {labels.zero}
      </text>
      {table.map((r, i) => {
        const y = 12 + i * ROW + ROW / 2;
        const px = x(r.seasonPnlPct);
        const up = r.seasonPnlPct >= 0;
        const color = flyColor(r.id, 60);
        const isSel = selected === r.slot;
        return (
          <g key={r.slot} role="listitem" onClick={() => onSelect(r.slot)} style={{ cursor: "pointer" }} aria-label={`${r.rank}. ${r.id} ${r.seasonPnlPct.toFixed(3)}%`}>
            {isSel && <rect x="0" y={12 + i * ROW} width={W} height={ROW} fill="rgba(252,213,53,0.06)" />}
            <text x="14" y={y + 4} fontSize="12" fill={r.rank === 1 ? "#fcd535" : "#848e9c"} className="tnum" fontWeight={r.rank <= 3 ? 600 : 400}>
              {r.rank}
            </text>
            <rect x={Math.min(cx, px)} y={y - 3} width={Math.max(1, Math.abs(px - cx))} height="6" fill={up ? "rgba(14,203,129,0.45)" : "rgba(246,70,93,0.45)"} rx="3" />
            <g transform={`translate(${px - 22} ${y - 19})`}>
              <FlySprite id={r.id} size={44} flying={r.status === "running"} dimmed={r.status === "stopped"} danger={r.relegationZone} crown={r.rank === 1} title={`${r.id} — ${r.seasonPnlPct >= 0 ? "+" : ""}${r.seasonPnlPct.toFixed(3)}%`} />
            </g>
            <text x={up ? px + 28 : px - 28} y={y - 4} textAnchor={up ? "start" : "end"} fontSize="11" fill={color} fontWeight={600}>
              {r.id}
            </text>
            <text x={up ? px + 28 : px - 28} y={y + 10} textAnchor={up ? "start" : "end"} fontSize="11" fill={up ? "#0ecb81" : "#f6465d"} className="tnum">
              {r.seasonPnlPct >= 0 ? "+" : ""}
              {r.seasonPnlPct.toFixed(3)}%{r.exposure ? " · LONG" : ""}
              {!r.active ? ` · ${labels.inactive}` : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
