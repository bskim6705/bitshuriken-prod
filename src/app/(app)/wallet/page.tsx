"use client";

import { useMemo, useState } from "react";
import {
  AssetTable,
  useAssetRows,
  useFuturesAssetRows,
  type AssetRow,
  type AssetTableState,
} from "@/components/wallet/asset-table";
import { TransferModal } from "@/components/wallet/transfer-modal";
import { FundingModal, type FundingMode } from "@/components/wallet/funding-modal";
import { UnifiedHistoryTable } from "@/components/wallet/unified-history-table";
import { NetWorthChart } from "@/components/wallet/net-worth-chart";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useNetWorth } from "@/lib/hooks/use-net-worth";
import { useUserStream } from "@/lib/hooks/use-trading";
import { useT } from "@/lib/i18n/provider";

const SUB_TABS = ["Overview", "Spot", "Futures", "Funding", "History", "Earn"] as const;
type SubTab = (typeof SUB_TABS)[number];
const ENABLED_TABS: ReadonlySet<SubTab> = new Set(["Overview", "Spot", "Futures", "History"]);
const TAB_LABEL_KEY: Record<SubTab, string> = {
  Overview: "wallet.tab.overview",
  Spot: "wallet.tab.spot",
  Futures: "wallet.tab.futures",
  Funding: "wallet.tab.funding",
  History: "wallet.tab.history",
  Earn: "wallet.tab.earn",
};

function filterRows(rows: AssetRow[], hideZero: boolean, search: string): AssetRow[] {
  let list = rows;
  if (hideZero) list = list.filter((r) => r.totalNum > 0);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter((r) => r.asset.toLowerCase().includes(q));
  }
  return list;
}

export default function WalletPage() {
  const t = useT();
  useUserStream();
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const spot = useAssetRows();
  const futures = useFuturesAssetRows();
  const netWorth = useNetWorth();
  const [tab, setTab] = useState<SubTab>("Overview");
  const [hideZero, setHideZero] = useState(false);
  const [search, setSearch] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [fundingMode, setFundingMode] = useState<FundingMode | null>(null);

  const isFutures = tab === "Futures";
  const isHistory = tab === "History";
  const isOverview = tab === "Overview";

  const filtered = useMemo(
    () => filterRows(isFutures ? futures.rows : spot.rows, hideZero, search),
    [isFutures, futures.rows, spot.rows, hideZero, search],
  );

  const signedOut = !authLoading && user == null;
  const spotState: AssetTableState = signedOut
    ? "signed-out"
    : authLoading || spot.loading
    ? "loading"
    : "ready";
  const futuresState: AssetTableState = signedOut
    ? "signed-out"
    : authLoading || futures.loading
    ? "loading"
    : "ready";

  const spotValue = spotState === "ready" ? spot.totalUsdt.toFixed(2) : "—";
  const futuresValue = futuresState === "ready" ? futures.totalUsdt.toFixed(2) : "—";
  const totalValue =
    spotState === "ready" && futuresState === "ready"
      ? (spot.totalUsdt + futures.totalUsdt).toFixed(2)
      : "—";

  // Today's PnL — 순자산 시계열 마지막 두 점의 차이(USDT + %). 2점 미만이면 "—".
  const pnl = useMemo(() => {
    const series = netWorth.data;
    if (!series || series.length < 2) return null;
    const last = Number(series[series.length - 1].totalUsdt);
    const prev = Number(series[series.length - 2].totalUsdt);
    const diff = last - prev;
    const pct = prev !== 0 ? (diff / prev) * 100 : 0;
    return { diff, pct };
  }, [netWorth.data]);

  return (
    <div className="px-3 py-3 w-full">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-[15px] font-semibold">{t("wallet.title")}</h1>
        <div className="flex items-center gap-1.5">
          <Button
            variant="primary"
            size="sm"
            disabled={user == null}
            onClick={() => setFundingMode("deposit")}
          >
            {t("wallet.deposit")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={user == null}
            onClick={() => setFundingMode("withdraw")}
          >
            {t("wallet.withdraw")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={user == null}
            onClick={() => setTransferOpen(true)}
          >
            {t("wallet.transfer")}
          </Button>
        </div>
      </div>

      <div className="bg-surface border border-line px-4 py-3 mb-2">
        <div className="flex items-center justify-between gap-6 flex-wrap">
          <div>
            <p className="text-[11px] text-text-dim">{t("wallet.estTotalValue")}</p>
            <p className="text-[22px] font-semibold tnum leading-tight">
              {totalValue}{" "}
              <span className="text-[12px] text-text-dim font-normal">USDT</span>
            </p>
            <p className="text-[11px] text-text-dim tnum">≈ $ {totalValue}</p>
          </div>
          <div className="flex items-center gap-5">
            <div>
              <p className="text-[11px] text-text-dim">{t("wallet.todaysPnl")}</p>
              {pnl ? (
                <p
                  className={`text-[13px] tnum leading-tight ${
                    pnl.diff > 0 ? "text-up" : pnl.diff < 0 ? "text-down" : "text-text"
                  }`}
                >
                  {pnl.diff >= 0 ? "+" : ""}
                  {pnl.diff.toFixed(2)}{" "}
                  <span className="text-[11px]">
                    ({pnl.pct >= 0 ? "+" : ""}
                    {pnl.pct.toFixed(2)}%)
                  </span>
                </p>
              ) : (
                <p className="text-[13px] tnum leading-tight">—</p>
              )}
            </div>
            {[
              { key: "spot", label: t("wallet.market.spot"), value: spotValue },
              { key: "futures", label: t("wallet.market.futures"), value: futuresValue },
            ].map((s) => (
              <div key={s.key}>
                <p className="text-[11px] text-text-dim">{s.label}</p>
                <p className="text-[13px] tnum leading-tight">{s.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center border-b border-line overflow-x-auto">
        {SUB_TABS.map((st) => (
          <button
            key={st}
            disabled={!ENABLED_TABS.has(st)}
            onClick={() => setTab(st)}
            className={`h-8 px-3 text-[12px] shrink-0 border-b-2 -mb-px whitespace-nowrap ${
              st === tab
                ? "text-text font-medium border-accent"
                : ENABLED_TABS.has(st)
                ? "text-text-dim hover:text-text border-transparent"
                : "text-text-muted cursor-not-allowed border-transparent"
            }`}
          >
            {t(TAB_LABEL_KEY[st])}
          </button>
        ))}
      </div>

      {!isHistory && (
        <div className="flex items-center gap-3 py-2">
          <input
            type="search"
            aria-label={t("wallet.searchCoinLabel")}
            placeholder={t("wallet.searchCoinPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 w-48 bg-surface border border-line px-2 text-[12px] placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
          <label className="flex items-center gap-1 text-[11px] text-text-dim">
            <input
              type="checkbox"
              checked={hideZero}
              onChange={(e) => setHideZero(e.target.checked)}
              className="w-3 h-3"
            />{" "}
            {t("wallet.hideZeroBalances")}
          </label>
          {isFutures && (
            <Button
              variant="outline"
              size="sm"
              disabled={user == null}
              onClick={() => setTransferOpen(true)}
              className="ml-auto"
            >
              {t("wallet.transfer")}
            </Button>
          )}
        </div>
      )}

      {isOverview && (
        <div className="mb-2">
          <NetWorthChart
            points={netWorth.data}
            loading={!signedOut && netWorth.isLoading}
            signedOut={signedOut}
            error={netWorth.isError}
          />
        </div>
      )}

      {isHistory ? (
        <UnifiedHistoryTable />
      ) : isFutures ? (
        <AssetTable rows={filtered} state={futuresState} />
      ) : (
        <AssetTable rows={filtered} state={spotState} showActions />
      )}

      {transferOpen && <TransferModal onClose={() => setTransferOpen(false)} />}
      {fundingMode && <FundingModal mode={fundingMode} onClose={() => setFundingMode(null)} />}
    </div>
  );
}
