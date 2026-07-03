"use client";

import { useMemo } from "react";
import { AssetTable, useAssetRows, type AssetRow, type AssetTableState } from "@/components/wallet/asset-table";
import { Panel, PanelEmpty } from "@/components/ui/panel";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useUserStream } from "@/lib/hooks/use-trading";
import { useT } from "@/lib/i18n/provider";

// "Other" 세그먼트는 빌더에서 이 센티넬로 표시하고 렌더에서 번역한다 (훅은 모듈 스코프 불가).
const OTHER_SEGMENT = "Other";

// 디자인 토큰 색 — top 5 + Other
const SEGMENT_COLORS = [
  "var(--color-accent)",
  "var(--color-up)",
  "var(--color-down)",
  "var(--color-accent-hover)",
  "var(--color-text-dim)",
  "var(--color-line-strong)",
];

interface Segment {
  label: string;
  value: number;
  fraction: number;
  color: string;
}

/** USDT 환산 가능한 자산을 비중 내림차순 top 5 + Other로 묶는다. */
function buildSegments(rows: AssetRow[]): Segment[] {
  const valued = rows.filter((r) => r.usdtValueNum != null && r.usdtValueNum > 0);
  const total = valued.reduce((sum, r) => sum + (r.usdtValueNum ?? 0), 0);
  if (total <= 0) return [];

  const top = valued.slice(0, 5).map((r, i) => ({
    label: r.asset,
    value: r.usdtValueNum ?? 0,
    fraction: (r.usdtValueNum ?? 0) / total,
    color: SEGMENT_COLORS[i],
  }));
  const otherValue = valued.slice(5).reduce((sum, r) => sum + (r.usdtValueNum ?? 0), 0);
  if (otherValue > 0) {
    top.push({
      label: OTHER_SEGMENT,
      value: otherValue,
      fraction: otherValue / total,
      color: SEGMENT_COLORS[5],
    });
  }
  return top;
}

function AllocationDonut({ segments }: { segments: Segment[] }) {
  const t = useT();
  const r = 44;
  const circumference = 2 * Math.PI * r;

  // 누적 offset 선계산 (렌더 콜백 내 변수 변이 금지)
  const arcs: { label: string; color: string; dash: number; offset: number }[] = [];
  let acc = 0;
  for (const s of segments) {
    const dash = s.fraction * circumference;
    arcs.push({ label: s.label, color: s.color, dash, offset: acc });
    acc += dash;
  }

  return (
    <div className="flex items-center gap-5 p-4">
      <svg width="150" height="150" viewBox="0 0 120 120" role="img" aria-label={t("portfolio.allocationAria")}>
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--color-raised)" strokeWidth="14" />
        <g transform="rotate(-90 60 60)">
          {arcs.map((a) => (
            <circle
              key={a.label}
              cx="60"
              cy="60"
              r={r}
              fill="none"
              stroke={a.color}
              strokeWidth="14"
              strokeDasharray={`${a.dash} ${circumference - a.dash}`}
              strokeDashoffset={-a.offset}
            />
          ))}
        </g>
      </svg>
      <ul className="flex flex-col gap-1.5 min-w-0">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-[11px]">
            <span
              className="w-2.5 h-2.5 shrink-0"
              style={{ backgroundColor: s.color }}
            />
            <span className="font-medium">
              {s.label === OTHER_SEGMENT ? t("portfolio.other") : s.label}
            </span>
            <span className="text-text-dim tnum">{(s.fraction * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PortfolioPage() {
  const t = useT();
  useUserStream();
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const { rows, totalUsdt, loading } = useAssetRows();

  const segments = useMemo(() => buildSegments(rows), [rows]);

  const signedOut = !authLoading && user == null;
  const state: AssetTableState = signedOut
    ? "signed-out"
    : authLoading || loading
    ? "loading"
    : "ready";
  const totalValue = state === "ready" ? totalUsdt.toFixed(2) : "—";

  return (
    <div className="px-3 py-3 w-full">
      <h1 className="text-[15px] font-semibold mb-2">{t("portfolio.title")}</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line border border-line mb-2">
        <div className="bg-surface px-3 py-2.5 col-span-2 md:col-span-4">
          <p className="text-[11px] text-text-dim">{t("portfolio.estTotalValue")}</p>
          <p className="text-[17px] font-semibold tnum mt-0.5 leading-tight">
            {totalValue}{" "}
            <span className="text-[11px] text-text-dim font-normal">USDT</span>
            <span className="ml-2 text-[11px] text-text-dim font-normal tnum">
              ≈ $ {totalValue}
            </span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-2">
        <div>
          <h2 className="text-[12px] font-medium mb-1.5 text-text-dim">{t("portfolio.holdings")}</h2>
          <AssetTable rows={rows} state={state} />
        </div>
        <div className="flex flex-col gap-2">
          <Panel title={t("portfolio.allocation")} className="min-h-[220px] border border-line">
            {state === "ready" && segments.length > 0 ? (
              <AllocationDonut segments={segments} />
            ) : (
              <PanelEmpty
                hint={
                  state === "signed-out"
                    ? t("portfolio.loginToView")
                    : state === "loading"
                    ? t("common.loading")
                    : t("portfolio.noValuedAssets")
                }
              />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
