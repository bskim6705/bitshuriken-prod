"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useAllTickers } from "@/lib/hooks/use-market";
import { useBalances } from "@/lib/hooks/use-trading";
import { useFuturesBalances } from "@/lib/hooks/use-futures-trading";
import type { Ticker24h } from "@/lib/types/market";
import { CoinIcon } from "@/components/common/coin-icon";
import { useT } from "@/lib/i18n/provider";

// 자산 1행 — free/locked는 BE 문자열 그대로, total/usdtValue는 추정 표시값
export interface AssetRow {
  asset: string;
  free: string;
  locked: string;
  total: string;
  totalNum: number;
  usdtValue: string | null;
  usdtValueNum: number | null;
  tradeSymbol: string | null;
}

export type AssetTableState = "loading" | "signed-out" | "ready";

interface BalanceLike {
  asset: string;
  free: string;
  locked: string;
}

/**
 * 잔고 + spot 티커 lastPrice로 USDT 환산 행을 만든다.
 * USDT/USDC는 1:1, USDT 페어 없는 자산은 환산 불가(null).
 */
function buildAssetRows(
  balances: BalanceLike[] | undefined,
  tickers: Ticker24h[] | null,
): { rows: AssetRow[]; totalUsdt: number } {
  const spotBySymbol = new Map<string, Ticker24h>();
  for (const t of tickers ?? []) {
    if (t.marketType === "SPOT") spotBySymbol.set(t.symbol, t);
  }

  const rows: AssetRow[] = (balances ?? []).map((b) => {
    const totalNum = Number(b.free) + Number(b.locked);
    const stable = b.asset === "USDT" || b.asset === "USDC";
    const pair = spotBySymbol.get(`${b.asset}USDT`) ?? null;
    const lastPrice = stable ? 1 : pair?.lastPrice != null ? Number(pair.lastPrice) : null;
    const usdtValueNum =
      lastPrice != null && Number.isFinite(lastPrice) && Number.isFinite(totalNum)
        ? totalNum * lastPrice
        : null;
    return {
      asset: b.asset,
      free: b.free,
      locked: b.locked,
      total: Number.isFinite(totalNum) ? totalNum.toFixed(8) : "—",
      totalNum,
      usdtValue: usdtValueNum != null ? usdtValueNum.toFixed(2) : null,
      usdtValueNum,
      tradeSymbol: pair?.symbol ?? null,
    };
  });

  rows.sort(
    (a, b) => (b.usdtValueNum ?? 0) - (a.usdtValueNum ?? 0) || a.asset.localeCompare(b.asset),
  );
  const totalUsdt = rows.reduce((sum, r) => sum + (r.usdtValueNum ?? 0), 0);
  return { rows, totalUsdt };
}

export function useAssetRows(): {
  rows: AssetRow[];
  totalUsdt: number;
  loading: boolean;
} {
  const { data: balances, isLoading } = useBalances();
  const tickers = useAllTickers();

  return useMemo(
    () => ({ ...buildAssetRows(balances, tickers), loading: isLoading }),
    [balances, tickers, isLoading],
  );
}

export function useFuturesAssetRows(): {
  rows: AssetRow[];
  totalUsdt: number;
  loading: boolean;
} {
  const { data: balances, isLoading } = useFuturesBalances();
  const tickers = useAllTickers();

  return useMemo(
    () => ({ ...buildAssetRows(balances, tickers), loading: isLoading }),
    [balances, tickers, isLoading],
  );
}

export function AssetTable({
  rows,
  state,
  showActions = false,
}: {
  rows: AssetRow[];
  state: AssetTableState;
  showActions?: boolean;
}) {
  const t = useT();
  const colCount = showActions ? 6 : 5;

  return (
    <div className="bg-surface border border-line">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[11px] text-text-dim border-b border-line">
              <th className="font-normal text-left px-3 py-1.5">{t("wallet.assetTable.coin")}</th>
              <th className="font-normal text-right px-3 py-1.5">{t("wallet.assetTable.total")}</th>
              <th className="font-normal text-right px-3 py-1.5">{t("wallet.assetTable.available")}</th>
              <th className="font-normal text-right px-3 py-1.5">{t("wallet.assetTable.inOrder")}</th>
              <th className="font-normal text-right px-3 py-1.5">{t("wallet.assetTable.usdtValue")}</th>
              {showActions && <th className="font-normal text-right px-3 py-1.5">{t("wallet.assetTable.actions")}</th>}
            </tr>
          </thead>
          <tbody>
            {state === "signed-out" && (
              <tr>
                <td colSpan={colCount} className="px-3 py-12 text-center text-[11px] text-text-muted">
                  <Link href="/login" className="text-accent hover:underline">
                    {t("wallet.assetTable.loginPre")}
                  </Link>{" "}
                  {t("wallet.assetTable.loginSuf")}
                </td>
              </tr>
            )}
            {state === "loading" && (
              <tr>
                <td colSpan={colCount} className="px-3 py-12 text-center text-[11px] text-text-muted">
                  {t("common.loading")}
                </td>
              </tr>
            )}
            {state === "ready" && rows.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-3 py-12 text-center text-[11px] text-text-muted">
                  {t("wallet.assetTable.noAssets")}
                </td>
              </tr>
            )}
            {state === "ready" &&
              rows.map((r) => (
                <tr
                  key={r.asset}
                  className="border-b border-line last:border-b-0 hover:bg-raised"
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <CoinIcon asset={r.asset} size={20} />
                      <span className="font-medium">{r.asset}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tnum">{r.total}</td>
                  <td className="px-3 py-2 text-right tnum text-text-dim">{r.free}</td>
                  <td className="px-3 py-2 text-right tnum text-text-dim">{r.locked}</td>
                  <td className="px-3 py-2 text-right tnum text-text-dim">
                    {r.usdtValue ?? "—"}
                  </td>
                  {showActions && (
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex gap-2">
                        <button
                          disabled
                          className="text-[11px] text-text-muted cursor-not-allowed"
                        >
                          {t("wallet.deposit")}
                        </button>
                        <button
                          disabled
                          className="text-[11px] text-text-muted cursor-not-allowed"
                        >
                          {t("wallet.withdraw")}
                        </button>
                        {r.tradeSymbol ? (
                          <Link
                            href={`/trade/${r.tradeSymbol}`}
                            className="text-[11px] text-accent hover:underline"
                          >
                            {t("wallet.trade")}
                          </Link>
                        ) : (
                          <span className="text-[11px] text-text-muted">{t("wallet.trade")}</span>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
