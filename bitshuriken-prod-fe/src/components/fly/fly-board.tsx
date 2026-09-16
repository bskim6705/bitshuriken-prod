"use client";

import { useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n/provider";
import { useFlyLeague } from "@/lib/hooks/use-fly";
import { FLY_API_URL } from "@/lib/api/fly";
import type { FlyStanding } from "@/lib/types/fly";
import { Panel, PanelEmpty } from "@/components/ui/panel";
import { FlyArena } from "./fly-arena";
import { FlyDetailPanel } from "./fly-detail";
import { FlyPnlChart } from "./fly-pnl-chart";
import { FlySprite, flyColor } from "./fly-sprite";

const pct = (v: number, d = 3) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

/** 서버가 준 secondsLeft를 기준으로 1초씩 흘려 보여 준다 (폴링 사이에도 시계가 간다). */
function useCountdown(secondsLeft: number | undefined, updatedAt: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (secondsLeft === undefined) return null;
  return Math.max(0, secondsLeft - Math.floor((now - updatedAt) / 1000));
}

function StandingsTable({ table, selected, onSelect }: { table: FlyStanding[]; selected: number | null; onSelect: (slot: number) => void }) {
  const t = useT();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-text-dim border-b border-line">
            <th className="px-3 py-2 text-left w-10">#</th>
            <th className="px-3 py-2 text-left">{t("fly.col.fly")}</th>
            <th className="px-3 py-2 text-left">{t("fly.col.parent")}</th>
            <th className="px-3 py-2 text-right">{t("fly.col.seasons")}</th>
            <th className="px-3 py-2 text-right">{t("fly.col.equity")}</th>
            <th className="px-3 py-2 text-right">{t("fly.col.seasonPnl")}</th>
            <th className="px-3 py-2 text-right">{t("fly.col.lifetime")}</th>
            <th className="px-3 py-2 text-right">{t("fly.col.orders")}</th>
            <th className="px-3 py-2 text-right">{t("fly.col.win")}</th>
            <th className="px-3 py-2 text-left">{t("fly.col.position")}</th>
          </tr>
        </thead>
        <tbody>
          {table.map((r) => (
            <tr
              key={r.slot}
              onClick={() => onSelect(r.slot)}
              className={`border-b border-line last:border-b-0 cursor-pointer ${selected === r.slot ? "bg-accent/5" : "hover:bg-raised"} ${r.relegationZone ? "bg-down/5" : ""}`}
            >
              <td className={`px-3 py-1.5 tnum ${r.rank === 1 ? "text-accent" : "text-text-dim"}`}>{r.rank}</td>
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <FlySprite id={r.id} size={26} flying={r.status === "running"} danger={r.relegationZone} />
                  <span className="font-medium" style={{ color: flyColor(r.id, 65) }}>
                    {r.id}
                  </span>
                  <span className={`text-[9px] px-1 py-px border ${r.status === "running" ? "border-up/40 text-up" : r.status === "warming" ? "border-accent/40 text-accent" : "border-line text-text-dim"}`}>{r.status}</span>
                  {!r.active && <span className="text-[9px] px-1 py-px border border-down/40 text-down">{t("fly.inactive")}</span>}
                </div>
              </td>
              <td className="px-3 py-1.5 font-mono text-text-dim">{r.parent ?? "—"}</td>
              <td className="px-3 py-1.5 text-right tnum">{r.seasons}</td>
              <td className="px-3 py-1.5 text-right tnum">{r.equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td className={`px-3 py-1.5 text-right tnum ${r.seasonPnlPct > 0 ? "text-up" : r.seasonPnlPct < 0 ? "text-down" : ""}`}>{pct(r.seasonPnlPct)}</td>
              <td className={`px-3 py-1.5 text-right tnum ${r.lifetimePnlPct > 0 ? "text-up" : r.lifetimePnlPct < 0 ? "text-down" : ""}`}>{pct(r.lifetimePnlPct, 2)}</td>
              <td className="px-3 py-1.5 text-right tnum">{r.ordersSeason}</td>
              <td className="px-3 py-1.5 text-right tnum">{(r.winRate * 100).toFixed(0)}%</td>
              <td className="px-3 py-1.5">{r.exposure ? <span className="text-up">LONG {r.positionQty.toFixed(5)}</span> : <span className="text-text-muted">{t("fly.flat")}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FlyBoard() {
  const t = useT();
  const { data, isLoading, isError, dataUpdatedAt } = useFlyLeague();
  const [selected, setSelected] = useState<number | null>(null);
  const left = useCountdown(data?.secondsLeft, dataUpdatedAt);
  const table = data?.table ?? [];
  const selectedRow = useMemo(() => table.find((r) => r.slot === selected) ?? null, [table, selected]);
  useEffect(() => {
    if (selected === null && table.length) setSelected(table[0]!.slot);
  }, [selected, table]);

  if (isLoading) return <p className="text-[12px] text-text-dim p-3">{t("common.loading")}</p>;
  if (isError || !data) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <h1 className="text-[18px] font-semibold">{t("fly.title")}</h1>
        <p className="text-[12px] text-text-dim">{t("fly.offline", { url: FLY_API_URL })}</p>
      </div>
    );
  }
  const hof = data.hallOfFame;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[18px] font-semibold flex items-center gap-2">
            <FlySprite id={`season-${data.season}`} size={30} flying />
            {t("fly.title")}
            <span className="text-[12px] font-normal text-text-dim">{data.symbol}</span>
          </h1>
          <p className="text-[12px] text-text-dim mt-0.5">{t("fly.subtitle")}</p>
        </div>
        <div className="flex items-center gap-4 text-[12px]">
          <Stat label={t("fly.season")} value={`#${data.season}${data.ending ? " …" : ""}`} />
          <Stat label={t("fly.timeLeft")} value={left === null ? "—" : mmss(left)} accent={left !== null && left < 120} />
          <Stat label={t("fly.flies")} value={String(table.length)} />
          <Stat label={t("fly.rule")} value={t("fly.ruleValue", { relegate: data.relegate, min: data.minTrades, fee: data.takerFeeBps })} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title={t("fly.arena")} className="border border-line">
          <div className="p-2">
            {table.length ? (
              <FlyArena table={table} selected={selected} onSelect={setSelected} labels={{ zero: "0%", relegation: t("fly.relegationZone"), inactive: t("fly.inactive") }} />
            ) : (
              <PanelEmpty hint={t("fly.empty")} />
            )}
          </div>
        </Panel>
        <Panel title={t("fly.pnlChart")} className="border border-line">
          <div className="p-2">
            <FlyPnlChart table={table} seasonStartedAt={data.seasonStartedAt} selected={selected} emptyHint={t("fly.chartEmpty")} />
          </div>
        </Panel>
      </div>

      <Panel title={t("fly.standings")} right={<span className="text-[11px] text-text-dim">{t("fly.capitalEach", { capital: data.capital.toLocaleString() })}</span>} className="border border-line">
        <StandingsTable table={table} selected={selected} onSelect={setSelected} />
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
        <Panel title={t("fly.detail")} className="border border-line">
          <FlyDetailPanel standing={selectedRow} />
        </Panel>
        <div className="flex flex-col gap-4">
          <Panel title={t("fly.hallOfFame")} className="border border-line">
            <dl className="grid grid-cols-1 gap-2 p-3 text-[12px]">
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-text-dim">{t("fly.hof.bestSeason")}</dt>
                <dd className="tnum">{hof.bestSeason ? `${hof.bestSeason.id} ${pct(hof.bestSeason.pnlPct)} (S${hof.bestSeason.season})` : "—"}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-text-dim">{t("fly.hof.longestSurvivor")}</dt>
                <dd className="tnum">{hof.longestSurvivor ? `${hof.longestSurvivor.id} · ${t("fly.detail.seasons", { n: hof.longestSurvivor.seasons })}` : "—"}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-text-dim">{t("fly.hof.titles")}</dt>
                <dd className="tnum">
                  {Object.entries(hof.champions)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([id, n]) => `${id}×${n}`)
                    .join(", ") || "—"}
                </dd>
              </div>
            </dl>
          </Panel>
          <Panel title={t("fly.history")} className="border border-line">
            {data.history.length ? (
              <ul className="divide-y divide-line text-[12px]">
                {data.history.map((s) => (
                  <li key={s.season} className="px-3 py-2 flex flex-col gap-0.5">
                    <div className="flex items-center justify-between">
                      <span className="text-text-dim">S{s.season}</span>
                      <span className="tnum">
                        🏆 <span style={{ color: flyColor(s.table[0]?.id ?? "", 65) }}>{s.table[0]?.id ?? "—"}</span>{" "}
                        <span className={s.table[0] && s.table[0].seasonPnlPct >= 0 ? "text-up" : "text-down"}>{s.table[0] ? pct(s.table[0].seasonPnlPct) : ""}</span>
                      </span>
                    </div>
                    <div className="text-[11px] text-text-dim font-mono truncate" title={`${t("fly.relegated")}: ${s.relegated.join(", ")}`}>
                      ↓ {s.relegated.join(", ")} → {s.newborn.map((n) => `${n.id}←${n.parent}`).join(", ")}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <PanelEmpty hint={t("fly.historyEmpty")} />
            )}
          </Panel>
        </div>
      </div>
      <p className="text-[11px] text-text-muted">
        {t("fly.footnote")}{" "}
        <a href={FLY_API_URL} target="_blank" rel="noreferrer" className="underline hover:text-text">
          {t("fly.rawDashboard")}
        </a>
      </p>
    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[10px] uppercase tracking-wide text-text-dim">{label}</span>
      <span className={`tnum ${accent ? "text-accent" : ""}`}>{value}</span>
    </div>
  );
}
