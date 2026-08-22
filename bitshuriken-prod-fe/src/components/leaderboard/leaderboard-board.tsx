"use client";

import { useState } from "react";
import { useLeaderboard } from "@/lib/hooks/use-leaderboard";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useT } from "@/lib/i18n/provider";
import type {
  LeaderboardEntry,
  LeaderboardMetric,
  LeaderboardWindow,
} from "@/lib/types/leaderboard";

const WINDOWS: { value: LeaderboardWindow; labelKey: string }[] = [
  { value: "DAILY", labelKey: "leaderboard.window.daily" },
  { value: "WEEKLY", labelKey: "leaderboard.window.weekly" },
  { value: "MONTHLY", labelKey: "leaderboard.window.monthly" },
  { value: "ALL", labelKey: "leaderboard.window.all" },
];

const METRICS: { value: LeaderboardMetric; labelKey: string }[] = [
  { value: "ROI", labelKey: "leaderboard.metric.roi" },
  { value: "PNL", labelKey: "leaderboard.metric.pnl" },
  { value: "VOLUME", labelKey: "leaderboard.metric.volume" },
];

// 메달 색 (1/2/3위)
const MEDAL: Record<number, { ring: string; text: string; chip: string }> = {
  1: { ring: "border-[#fcd535]", text: "text-[#fcd535]", chip: "bg-[#fcd535] text-bg" },
  2: { ring: "border-[#c0c7d0]", text: "text-[#c0c7d0]", chip: "bg-[#c0c7d0] text-bg" },
  3: { ring: "border-[#cd7f32]", text: "text-[#cd7f32]", chip: "bg-[#cd7f32] text-bg" },
};

interface Formatted {
  text: string;
  cls: string;
}

function fmtPct(v: string | null): Formatted {
  if (v === null) return { text: "—", cls: "text-text-muted" };
  const n = Number(v);
  const sign = n > 0 ? "+" : "";
  return {
    text: `${sign}${n.toFixed(2)}%`,
    cls: n > 0 ? "text-up" : n < 0 ? "text-down" : "text-text",
  };
}

function fmtUsdSigned(v: string | null): Formatted {
  if (v === null) return { text: "—", cls: "text-text-muted" };
  const n = Number(v);
  const sign = n > 0 ? "+" : "";
  const body = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return {
    text: `${n < 0 ? "-" : sign}${body}`,
    cls: n > 0 ? "text-up" : n < 0 ? "text-down" : "text-text",
  };
}

/** 거래대금 — K/M/B 축약, 중립색. */
function fmtVolume(v: string): Formatted {
  const n = Number(v);
  if (!Number.isFinite(n)) return { text: "—", cls: "text-text-muted" };
  const abs = Math.abs(n);
  let text: string;
  if (abs >= 1e9) text = `${(n / 1e9).toFixed(2)}B`;
  else if (abs >= 1e6) text = `${(n / 1e6).toFixed(2)}M`;
  else if (abs >= 1e3) text = `${(n / 1e3).toFixed(2)}K`;
  else text = n.toFixed(2);
  return { text, cls: "text-text" };
}

function metricValue(e: LeaderboardEntry, metric: LeaderboardMetric): Formatted {
  if (metric === "ROI") return fmtPct(e.roi);
  if (metric === "PNL") return fmtUsdSigned(e.pnl);
  return fmtVolume(e.volume);
}

function initial(name: string): string {
  const c = name.trim()[0];
  return c ? c.toUpperCase() : "?";
}

function Tabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; labelKey: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`h-7 px-3 text-[12px] border ${
            o.value === value
              ? "border-accent text-accent"
              : "border-line text-text-dim hover:text-text"
          }`}
        >
          {t(o.labelKey)}
        </button>
      ))}
    </div>
  );
}

function PodiumCard({
  entry,
  metric,
  isMe,
}: {
  entry: LeaderboardEntry;
  metric: LeaderboardMetric;
  isMe: boolean;
}) {
  const t = useT();
  const medal = MEDAL[entry.rank];
  const main = metricValue(entry, metric);
  const top = entry.rank === 1;
  return (
    <div
      className={`bg-surface border ${medal?.ring ?? "border-line"} ${
        top ? "sm:-mt-2" : ""
      } p-4 flex flex-col items-center text-center`}
    >
      <span
        className={`mb-2 inline-flex items-center justify-center w-6 h-6 text-[12px] font-bold ${
          medal?.chip ?? "bg-line text-text"
        }`}
      >
        {entry.rank}
      </span>
      <div
        className={`w-12 h-12 rounded-full grid place-items-center text-[18px] font-semibold border ${
          medal?.ring ?? "border-line"
        } ${medal?.text ?? "text-text"}`}
      >
        {initial(entry.name)}
      </div>
      <div className="mt-2 flex items-center gap-1.5 max-w-full">
        <span className="text-[13px] font-medium text-text truncate" title={entry.name}>
          {entry.name}
        </span>
        {isMe && (
          <span className="text-[9px] px-1 py-px border border-accent text-accent shrink-0">{t("leaderboard.you")}</span>
        )}
      </div>
      <div className={`mt-1 text-[18px] tnum font-semibold ${main.cls}`}>{main.text}</div>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-text-dim tnum">
        {metric !== "ROI" && <span>{t("leaderboard.short.roi")} {fmtPct(entry.roi).text}</span>}
        {metric !== "PNL" && <span>{t("leaderboard.short.pnl")} {fmtUsdSigned(entry.pnl).text}</span>}
        {metric !== "VOLUME" && <span>{t("leaderboard.short.volume")} {fmtVolume(entry.volume).text}</span>}
      </div>
    </div>
  );
}

function Row({
  entry,
  metric,
  isMe,
}: {
  entry: LeaderboardEntry;
  metric: LeaderboardMetric;
  isMe: boolean;
}) {
  const t = useT();
  const medal = MEDAL[entry.rank];
  const roi = fmtPct(entry.roi);
  const pnl = fmtUsdSigned(entry.pnl);
  const vol = fmtVolume(entry.volume);
  const hl = (m: LeaderboardMetric) =>
    metric === m ? "font-medium" : "text-text-dim";
  return (
    <tr className={`border-b border-line last:border-b-0 ${isMe ? "bg-accent/5" : "hover:bg-raised"}`}>
      <td className="px-3 py-2 w-12">
        <span className={`tnum text-[12px] ${medal?.text ?? "text-text-dim"}`}>{entry.rank}</span>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-full bg-raised grid place-items-center text-[11px] text-text-dim shrink-0">
            {initial(entry.name)}
          </span>
          <span className="text-[12px] text-text truncate max-w-[180px]" title={entry.name}>
            {entry.name}
          </span>
          {isMe && (
            <span className="text-[9px] px-1 py-px border border-accent text-accent shrink-0">{t("leaderboard.you")}</span>
          )}
        </div>
      </td>
      <td className={`px-3 py-2 text-right tnum ${metric === "ROI" ? roi.cls : "text-text-dim"} ${hl("ROI")}`}>
        {roi.text}
      </td>
      <td className={`px-3 py-2 text-right tnum ${metric === "PNL" ? pnl.cls : "text-text-dim"} ${hl("PNL")}`}>
        {pnl.text}
      </td>
      <td className={`px-3 py-2 text-right tnum ${vol.cls} ${hl("VOLUME")}`}>{vol.text}</td>
    </tr>
  );
}

export function LeaderboardBoard() {
  const t = useT();
  const [window, setWindow] = useState<LeaderboardWindow>("WEEKLY");
  const [metric, setMetric] = useState<LeaderboardMetric>("ROI");

  const { data, isLoading, isError } = useLeaderboard({ window, metric, limit: 100 });
  const { data: user } = useCurrentUser();
  const myId = user?.id ?? null;

  const rows = data?.rows ?? [];
  const podium = rows.slice(0, 3);
  const rest = rows.slice(3);

  const metricNote =
    metric === "ROI"
      ? t("leaderboard.note.roi")
      : metric === "PNL"
      ? t("leaderboard.note.pnl")
      : t("leaderboard.note.volume");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[18px] font-semibold">{t("leaderboard.title")}</h1>
          <p className="text-[12px] text-text-dim mt-0.5">{metricNote}</p>
        </div>
        <Tabs options={WINDOWS} value={window} onChange={setWindow} />
      </div>

      <Tabs options={METRICS} value={metric} onChange={setMetric} />

      {isLoading && (
        <div className="bg-surface border border-line px-3 py-16 text-center text-[12px] text-text-muted">
          {t("common.loading")}
        </div>
      )}

      {!isLoading && isError && (
        <div className="bg-surface border border-line px-3 py-16 text-center text-[12px] text-down">
          {t("leaderboard.loadFailed")}
        </div>
      )}

      {!isLoading && !isError && rows.length === 0 && (
        <div className="bg-surface border border-line px-3 py-16 text-center text-[12px] text-text-muted">
          {t("leaderboard.empty")}
        </div>
      )}

      {!isLoading && !isError && rows.length > 0 && (
        <>
          {podium.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {podium.map((e) => (
                <PodiumCard key={e.userId} entry={e} metric={metric} isMe={e.userId === myId} />
              ))}
            </div>
          )}

          {rest.length > 0 && (
            <div className="bg-surface border border-line overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-[11px] text-text-dim border-b border-line">
                    <th className="font-normal px-3 py-1.5 text-left">#</th>
                    <th className="font-normal px-3 py-1.5 text-left">{t("leaderboard.col.trader")}</th>
                    <th className="font-normal px-3 py-1.5 text-right">{t("leaderboard.col.roi")}</th>
                    <th className="font-normal px-3 py-1.5 text-right">{t("leaderboard.col.pnl")}</th>
                    <th className="font-normal px-3 py-1.5 text-right">{t("leaderboard.col.volume")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rest.map((e) => (
                    <Row key={e.userId} entry={e} metric={metric} isMe={e.userId === myId} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
