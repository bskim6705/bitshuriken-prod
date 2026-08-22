import type { ReactNode } from "react";

/** KPI tile for the dashboard. */
export function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="bg-surface border border-line p-3">
      <div className="text-[11px] text-text-dim">{label}</div>
      <div className="text-[18px] font-semibold tnum mt-1 leading-tight">{value}</div>
      {sub != null && <div className="text-[11px] text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/** Titled surface section with an optional header action. */
export function AdminCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bg-surface border border-line">
      <header className="flex items-center justify-between px-3 h-9 border-b border-line">
        <h3 className="text-[12px] font-medium">{title}</h3>
        {action}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

export type BadgeTone = "neutral" | "up" | "down" | "accent" | "muted";

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "bg-raised border-line text-text-dim",
  up: "bg-up/15 border-up/40 text-up",
  down: "bg-down/15 border-down/40 text-down",
  accent: "bg-accent/15 border-accent/40 text-accent",
  muted: "bg-raised border-line text-text-muted",
};

/** Small status pill — pairs color with text so meaning isn't color-only. */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center px-1.5 h-4 text-[10px] border ${BADGE_TONE[tone]}`}>
      {children}
    </span>
  );
}

export function Th({ children, first }: { children?: ReactNode; first?: boolean }) {
  return (
    <th
      scope="col"
      className={`font-normal px-3 py-1.5 text-[11px] text-text-dim ${first ? "text-left" : "text-right"}`}
    >
      {children}
    </th>
  );
}

/** Shimmer placeholder rows while a table loads (respects reduced-motion via globals). */
export function SkeletonRows({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-line last:border-b-0">
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} className="px-3 py-2">
              <div
                className="h-3 bg-raised animate-pulse"
                style={{ width: `${40 + ((r + c) % 4) * 15}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function EmptyRow({ cols, label }: { cols: number; label: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-8 text-center text-[11px] text-text-muted">
        {label}
      </td>
    </tr>
  );
}
