"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { fetchTransactions } from "@/lib/api/transactions";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useTransactions } from "@/lib/hooks/use-transactions";
import { useT } from "@/lib/i18n/provider";
import type { FundingTx, FundingTxType } from "@/lib/types/funding-tx";
import type { MarketType } from "@/lib/types/market";

// 표시 라벨은 키로 보관하고 렌더에서 t()로 해석한다 (훅은 모듈 스코프 불가).
const COL_KEYS = [
  "wallet.history.colDate",
  "wallet.history.colType",
  "wallet.history.colAsset",
  "wallet.history.colAmount",
  "wallet.history.colRoute",
  "wallet.history.colStatus",
];

const ALL = "ALL";
const PAGE_SIZE = 100;

const TYPE_FILTERS: { value: string; labelKey: string }[] = [
  { value: ALL, labelKey: "wallet.history.filterAll" },
  { value: "DEPOSIT", labelKey: "wallet.history.typeDeposit" },
  { value: "WITHDRAWAL", labelKey: "wallet.history.typeWithdrawal" },
  { value: "TRANSFER", labelKey: "wallet.history.typeTransfer" },
];

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

const TYPE_LABEL_KEY: Record<FundingTxType, string> = {
  DEPOSIT: "wallet.history.typeDeposit",
  WITHDRAWAL: "wallet.history.typeWithdrawal",
  TRANSFER: "wallet.history.typeTransfer",
};

const TYPE_BADGE: Record<FundingTxType, string> = {
  DEPOSIT: "border-up/40 text-up",
  WITHDRAWAL: "border-down/40 text-down",
  TRANSFER: "border-line-strong text-text-dim",
};

const MARKET_LABEL_KEY: Record<MarketType, string> = {
  SPOT: "wallet.market.spot",
  FUTURES: "wallet.market.futures",
};

/** "0.10000000" → "0.1", "50.00000000" → "50" (fixed-8 trailing zero trim) */
function trimQty(v: string): string {
  if (!v.includes(".")) return v;
  return v.replace(/\.?0+$/, "");
}

export function HistoryTable() {
  const t = useT();
  const marketLabel = (m: MarketType | null): string => (m ? t(MARKET_LABEL_KEY[m]) : "—");
  const routeLabel = (tx: FundingTx): string =>
    `${marketLabel(tx.fromMarket)} → ${marketLabel(tx.toMarket)}`;

  const { data: user, isLoading: authLoading } = useCurrentUser();
  const [type, setType] = useState<string>(ALL);
  // 첫 페이지는 useTransactions(invalidate 대상), 과거 페이지는 endTime 커서로 append
  const [olderPages, setOlderPages] = useState<FundingTx[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeParam = type === ALL ? undefined : (type as FundingTxType);
  const { data: firstPage, isLoading } = useTransactions({ type: typeParam, limit: PAGE_SIZE });

  // 첫 페이지 + 과거 페이지 결합 (커서 경계 중복은 id로 제거)
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: FundingTx[] = [];
    for (const t of [...(firstPage ?? []), ...olderPages]) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
    return out.sort((a, b) => b.time - a.time);
  }, [firstPage, olderPages]);

  const onTypeChange = (value: string) => {
    setType(value);
    setOlderPages([]);
    setExhausted(false);
    setError(null);
  };

  const reachedEnd =
    exhausted || (olderPages.length === 0 && (firstPage?.length ?? 0) < PAGE_SIZE);

  const loadMore = async () => {
    const oldest = rows[rows.length - 1];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchTransactions({
        type: typeParam,
        limit: PAGE_SIZE,
        endTime: oldest.time,
      });
      // 커서가 inclusive(lte)라 경계 중복 가능 — 새 행이 없으면 끝으로 간주
      const existing = new Set(rows.map((t) => t.id));
      const fresh = page.filter((t) => !existing.has(t.id));
      setOlderPages((prev) => [...prev, ...fresh]);
      if (fresh.length === 0 || page.length < PAGE_SIZE) setExhausted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("wallet.history.failedLoadMore"));
    } finally {
      setLoadingMore(false);
    }
  };

  const signedOut = !authLoading && user == null;
  const loading = authLoading || (user != null && isLoading);

  return (
    <div>
      <div className="flex items-center gap-2 py-2">
        <select
          value={type}
          onChange={(e) => onTypeChange(e.target.value)}
          className="h-7 bg-surface border border-line px-2 text-[11px]"
        >
          {TYPE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {t(f.labelKey)}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="mb-2 px-2 py-1.5 text-[11px] text-down bg-down-soft border border-down/40">
          {error}
        </p>
      )}

      <div className="bg-surface border border-line">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[11px] text-text-dim border-b border-line">
                {COL_KEYS.map((c, i) => (
                  <th
                    key={i}
                    className={`font-normal px-3 py-1.5 whitespace-nowrap ${
                      i === 0 || i === 1 ? "text-left" : i === 5 ? "text-left" : "text-right"
                    }`}
                  >
                    {t(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {signedOut && (
                <tr>
                  <td colSpan={COL_KEYS.length} className="px-3 py-12 text-center text-[11px] text-text-muted">
                    <Link href="/login" className="text-accent hover:underline">
                      {t("wallet.history.loginPre")}
                    </Link>{" "}
                    {t("wallet.history.loginSuf")}
                  </td>
                </tr>
              )}
              {!signedOut && loading && (
                <tr>
                  <td colSpan={COL_KEYS.length} className="px-3 py-12 text-center text-[11px] text-text-muted">
                    {t("common.loading")}
                  </td>
                </tr>
              )}
              {!signedOut && !loading && rows.length === 0 && (
                <tr>
                  <td colSpan={COL_KEYS.length} className="px-3 py-12 text-center text-[11px] text-text-muted">
                    {t("wallet.history.noTransactions")}
                  </td>
                </tr>
              )}
              {!signedOut &&
                !loading &&
                rows.map((tx) => (
                  <tr key={tx.id} className="border-b border-line last:border-b-0 hover:bg-raised">
                    <td className="px-3 py-2 tnum text-text-dim whitespace-nowrap">
                      {formatDateTime(tx.time)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`px-1.5 py-px text-[10px] border align-middle ${TYPE_BADGE[tx.type]}`}
                      >
                        {t(TYPE_LABEL_KEY[tx.type])}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{tx.assetSymbol}</td>
                    <td className="px-3 py-2 text-right tnum whitespace-nowrap">{trimQty(tx.qty)}</td>
                    <td className="px-3 py-2 text-right tnum text-text-dim whitespace-nowrap">
                      {routeLabel(tx)}
                    </td>
                    <td className="px-3 py-2 text-text-dim whitespace-nowrap">{tx.status}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!signedOut && !loading && rows.length > 0 && !reachedEnd && (
          <div className="border-t border-line py-2 text-center">
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="h-7 px-3 text-[11px] text-accent hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loadingMore ? t("common.loading") : t("wallet.history.loadMore")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
