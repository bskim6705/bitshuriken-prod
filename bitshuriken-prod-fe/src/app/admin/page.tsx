"use client";

import { useAdminOverview } from "@/lib/hooks/use-admin";
import { InlineError } from "@/components/ui/inline-error";
import { AdminCard, Badge, EmptyRow, Metric, Th, type BadgeTone } from "@/components/admin/ui";
import { formatDateTime, formatInt, formatNum } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";

const STATUS_TONE: Record<string, BadgeTone> = {
  TRADING: "up",
  DELISTED: "down",
  HALTED: "accent",
  PENDING: "neutral",
};

function AssetTable({
  rows,
  emptyLabel,
}: {
  rows: { asset: string; total: string }[];
  emptyLabel: string;
}) {
  const t = useT();
  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="border-b border-line">
          <Th first>{t("common.asset")}</Th>
          <Th>{t("admin.dashboard.col.total")}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <EmptyRow cols={2} label={emptyLabel} />}
        {rows.map((r) => (
          <tr key={r.asset} className="border-b border-line last:border-b-0">
            <td className="px-3 py-1.5 text-left">{r.asset}</td>
            <td className="px-3 py-1.5 text-right tnum">{formatNum(r.total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AdminDashboardPage() {
  const t = useT();
  const { data, isLoading, error } = useAdminOverview();

  if (error) {
    return <InlineError>{error instanceof Error ? error.message : t("admin.dashboard.loadError")}</InlineError>;
  }

  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="bg-surface border border-line p-3">
            <div className="h-3 w-20 bg-raised animate-pulse" />
            <div className="h-5 w-16 bg-raised animate-pulse mt-2" />
          </div>
        ))}
      </div>
    );
  }

  const { users, markets, activity, financials, recentAdjustments } = data;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric
          label={t("admin.dashboard.totalUsers")}
          value={formatInt(users.total)}
          sub={t("admin.dashboard.usersSub", {
            new24h: formatInt(users.new24h),
            new7d: formatInt(users.new7d),
          })}
        />
        <Metric label={t("admin.dashboard.admins")} value={formatInt(users.admins)} />
        <Metric
          label={t("admin.dashboard.restrictedUsers")}
          value={
            users.restricted > 0 ? (
              <span className="text-down">{formatInt(users.restricted)}</span>
            ) : (
              formatInt(users.restricted)
            )
          }
          sub={t("admin.dashboard.restrictedSub")}
        />
        <Metric
          label={t("admin.dashboard.markets")}
          value={formatInt(markets.total)}
          sub={t("admin.dashboard.marketsTradingSub", { count: markets.byStatus.TRADING ?? 0 })}
        />
        <Metric label={t("admin.dashboard.openOrders")} value={formatInt(activity.openOrders)} />
        <Metric label={t("admin.dashboard.openPositions")} value={formatInt(activity.openPositions)} />
        <Metric label={t("admin.dashboard.totalTrades")} value={formatInt(activity.totalTrades)} />
        <Metric
          label={t("admin.dashboard.insuranceFund")}
          value={formatNum(financials.insuranceFundUsdt, 2)}
          sub={t("admin.dashboard.insuranceFundSub")}
        />
      </div>

      <AdminCard title={t("admin.dashboard.marketsByStatus")}>
        <div className="p-3 flex flex-wrap gap-2">
          {Object.keys(markets.byStatus).length === 0 && (
            <span className="text-[11px] text-text-muted">{t("admin.dashboard.noMarkets")}</span>
          )}
          {Object.entries(markets.byStatus).map(([status, count]) => (
            <Badge key={status} tone={STATUS_TONE[status] ?? "neutral"}>
              {status} · {count}
            </Badge>
          ))}
        </div>
      </AdminCard>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <AdminCard title={t("admin.dashboard.platformBalances")}>
          <AssetTable rows={financials.balancesByAsset} emptyLabel={t("admin.dashboard.noBalances")} />
        </AdminCard>
        <AdminCard title={t("admin.dashboard.feeRevenue")}>
          <AssetTable rows={financials.feeRevenueByAsset} emptyLabel={t("admin.dashboard.noFees")} />
        </AdminCard>
      </div>

      <AdminCard title={t("admin.dashboard.recentAdjustments")}>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-line">
              <Th first>{t("admin.dashboard.col.user")}</Th>
              <Th>{t("admin.dashboard.col.direction")}</Th>
              <Th>{t("common.asset")}</Th>
              <Th>{t("admin.dashboard.col.qty")}</Th>
              <Th>{t("admin.dashboard.col.reason")}</Th>
              <Th>{t("common.time")}</Th>
            </tr>
          </thead>
          <tbody>
            {recentAdjustments.length === 0 && <EmptyRow cols={6} label={t("admin.dashboard.noAdjustments")} />}
            {recentAdjustments.map((a) => (
              <tr key={a.id} className="border-b border-line last:border-b-0 hover:bg-raised">
                <td className="px-3 py-1.5 text-left">
                  <a href={`/admin/users/${a.userId}`} className="text-accent hover:underline tnum text-[11px]">
                    {a.userId.slice(0, 8)}…
                  </a>
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Badge tone={a.direction === "credit" ? "up" : "down"}>
                    {a.direction === "credit"
                      ? t("admin.dashboard.direction.credit")
                      : t("admin.dashboard.direction.debit")}
                  </Badge>
                </td>
                <td className="px-3 py-1.5 text-right">{a.assetSymbol}</td>
                <td className="px-3 py-1.5 text-right tnum">{formatNum(a.qty)}</td>
                <td className="px-3 py-1.5 text-right text-text-dim max-w-[200px] truncate" title={a.reason ?? undefined}>
                  {a.reason ?? "—"}
                </td>
                <td className="px-3 py-1.5 text-right tnum text-text-dim">{formatDateTime(a.time)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </AdminCard>
    </div>
  );
}
