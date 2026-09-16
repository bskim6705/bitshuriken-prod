"use client";

import { useEffect, useRef } from "react";
import { useT } from "@/lib/i18n/provider";
import { useFlyDetail } from "@/lib/hooks/use-fly";
import type { FlyStanding } from "@/lib/types/fly";
import { FlySprite, flyColor } from "./fly-sprite";

const SENSORY = new Set(["ORN", "ORN_PHEROMONE", "GRN", "MECH_JO", "MECH_BRISTLE", "THERMO_HYGRO"]);

function ReadoutChart({ history, thetaIn, thetaOut }: { history: { t: number; yhat: number; exposure: number }[]; thetaIn: number; thetaOut: number }) {
  const W = 600;
  const H = 140;
  const pad = 8;
  if (history.length < 2) return <div className="h-[140px]" />;
  const lim = Math.max(Math.abs(thetaIn), Math.abs(thetaOut), ...history.map((p) => Math.abs(p.yhat)), 1e-6) * 1.1;
  const x = (i: number) => pad + (i / (history.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H / 2 - (v / lim) * (H / 2 - pad);
  const d = history.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.yhat).toFixed(1)}`).join(" ");
  const bw = Math.max(1, (W - 2 * pad) / history.length);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="readout" className="block bg-bg border border-line">
      {history.map((p, i) => (p.exposure > 0 ? <rect key={i} x={x(i)} y={pad} width={bw} height={H / 2 - pad} fill="rgba(14,203,129,0.18)" /> : null))}
      {[0, thetaIn, thetaOut].map((lvl, i) => (
        <line key={i} x1={pad} x2={W - pad} y1={y(lvl)} y2={y(lvl)} stroke={i === 0 ? "#474d57" : i === 1 ? "rgba(14,203,129,0.6)" : "rgba(246,70,93,0.6)"} strokeDasharray="4 4" />
      ))}
      <path d={d} fill="none" stroke="#fcd535" strokeWidth="1.5" />
    </svg>
  );
}

function DescendingHeatmap({ values }: { values: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const n = values.length;
    const cols = Math.ceil(Math.sqrt(n * 2.6));
    const rows = Math.ceil(n / cols);
    const cell = Math.max(3, Math.floor(cv.clientWidth / cols));
    const dpr = window.devicePixelRatio || 1;
    cv.width = cols * cell * dpr;
    cv.height = rows * cell * dpr;
    cv.style.height = `${rows * cell}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#0b0e11";
    ctx.fillRect(0, 0, cols * cell, rows * cell);
    let maxAbs = 1e-6;
    for (const v of values) maxAbs = Math.max(maxAbs, Math.abs(v));
    for (let i = 0; i < n; i++) {
      const v = values[i]! / maxAbs;
      const a = Math.min(1, Math.abs(v)) ** 0.6;
      ctx.fillStyle = v >= 0 ? `rgba(252,160,53,${a})` : `rgba(80,140,255,${a})`;
      ctx.fillRect((i % cols) * cell, Math.floor(i / cols) * cell, cell - 1, cell - 1);
    }
  }, [values]);
  return <canvas ref={ref} className="w-full border border-line bg-bg" style={{ imageRendering: "pixelated" }} aria-label="descending neurons" />;
}

export function FlyDetailPanel({ standing }: { standing: FlyStanding | null }) {
  const t = useT();
  const { data, isError } = useFlyDetail(standing?.slot ?? null);
  if (!standing) return <p className="text-[12px] text-text-muted p-3">{t("fly.detail.select")}</p>;
  if (isError || !data) return <p className="text-[12px] text-text-muted p-3">{t("fly.detail.loading")}</p>;
  const snap = data.snapshot;
  const maxMean = snap ? Math.max(...snap.populations.map((p) => p.mean), 1e-9) : 1;
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}%`;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-3">
        <FlySprite id={standing.id} size={56} flying={data.status === "running"} danger={standing.relegationZone} crown={standing.rank === 1} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold" style={{ color: flyColor(standing.id, 65) }}>
              {standing.id}
            </span>
            <span className="text-[11px] text-text-dim">
              #{standing.rank} · {t("fly.col.parent")} {standing.parent ?? "—"} · {t("fly.detail.seasons", { n: standing.seasons })}
            </span>
          </div>
          <div className="text-[11px] text-text-dim mt-0.5">
            {data.model.neurons.toLocaleString()} {t("fly.detail.neurons")} · H={data.model.horizon}s · {t("fly.detail.replayIc")} {data.model.valIc.toFixed(3)} · {data.status}
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-[12px]">
        <Metric label={t("fly.col.equity")} value={data.equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
        <Metric label={t("fly.col.seasonPnl")} value={pct(standing.seasonPnlPct)} cls={standing.seasonPnlPct >= 0 ? "text-up" : "text-down"} />
        <Metric label={t("fly.col.position")} value={data.positionQty > 0 ? `${data.positionQty.toFixed(5)} BTC` : t("fly.flat")} />
        <Metric label="ŷ" value={snap ? snap.yhat.toFixed(4) : "—"} cls={snap && snap.yhat > 0 ? "text-up" : snap && snap.yhat < 0 ? "text-down" : ""} />
        <Metric label={t("fly.detail.thresholds")} value={`${data.policy.thetaInAbs.toFixed(4)} / ${data.policy.thetaOutAbs.toFixed(4)}`} />
        <Metric label={t("fly.detail.brain")} value={`gain ${data.model.brain.gain.toFixed(2)} · leak ${data.model.brain.leak.toFixed(2)} · K=${data.model.brain.substeps} · p=${data.model.brain.normP.toFixed(2)}`} />
      </dl>
      <div>
        <p className="text-[10px] uppercase tracking-wide text-text-dim mb-1">{t("fly.detail.readout")}</p>
        <ReadoutChart history={data.history} thetaIn={data.policy.thetaInAbs} thetaOut={data.policy.thetaOutAbs} />
      </div>
      {snap && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-text-dim mb-1">{t("fly.detail.populations")}</p>
            <ul className="flex flex-col gap-[3px]">
              {snap.populations.map((p) => (
                <li key={p.name} className="grid grid-cols-[110px_1fr_44px] items-center gap-2 text-[11px]">
                  <span className={`font-mono ${p.name === "DESCENDING" ? "text-accent" : SENSORY.has(p.name) ? "text-up" : "text-text-dim"}`}>{p.name}</span>
                  <span className="h-2 bg-bg overflow-hidden rounded-sm">
                    <span className={`block h-full ${p.name === "DESCENDING" ? "bg-accent" : SENSORY.has(p.name) ? "bg-up" : "bg-line-strong"}`} style={{ width: `${(p.mean / maxMean) * 100}%` }} />
                  </span>
                  <span className="text-right tnum text-text-dim">{p.mean.toFixed(3)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-text-dim mb-1">{t("fly.detail.descending")}</p>
            <DescendingHeatmap values={snap.descending} />
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-text-dim">{label}</dt>
      <dd className={`tnum truncate ${cls}`} title={value}>
        {value}
      </dd>
    </div>
  );
}
