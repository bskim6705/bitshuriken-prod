"use client";

import { useMemo, type ReactNode } from "react";
import { PanelEmpty } from "@/components/ui/panel";
import type { MyTrade } from "@/lib/types/trading";
import { useT } from "@/lib/i18n/provider";

export const TH =
  "sticky top-0 bg-surface font-normal text-left px-3 py-1.5 text-[11px] text-text-dim whitespace-nowrap";
export const TD = "px-3 py-1.5 whitespace-nowrap";

export function formatDateTime(value: string | number): string {
  const d = new Date(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface PanelColumn<T> {
  key: string;
  header: string;
  /** TH 뒤 추가 클래스 (예: text-right). */
  thClass?: string;
  /** TD 뒤 추가 클래스 — 생략 시 TD만. */
  tdClass?: string | ((row: T) => string);
  cell: (row: T) => ReactNode;
}

export function PanelTable<T>({
  columns,
  rows,
  rowKey,
}: {
  columns: PanelColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
}) {
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-[12px] tnum border-collapse">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.thClass ? `${TH} ${c.thClass}` : TH}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-t border-line hover:bg-raised/50">
              {columns.map((c) => {
                const extra = typeof c.tdClass === "function" ? c.tdClass(row) : c.tdClass;
                return (
                  <td key={c.key} className={extra ? `${TD} ${extra}` : TD}>
                    {c.cell(row)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 행 우측 액션 (Cancel/Close) — busy 시 라벨 교체 + 비활성. */
export function RowActionButton({
  busy,
  busyLabel,
  label,
  disabled,
  onClick,
}: {
  busy: boolean;
  busyLabel: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="text-[11px] text-accent hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
      disabled={busy || disabled}
      onClick={onClick}
    >
      {busy ? busyLabel : label}
    </button>
  );
}

/** 쿼리 상태 → Loading/에러/빈 목록 힌트, 정상 시에만 테이블 생성. */
export function QueryTabBody({
  isPending,
  isError,
  errorHint,
  isEmpty,
  emptyHint,
  children,
}: {
  isPending: boolean;
  isError: boolean;
  errorHint: string;
  isEmpty: boolean;
  emptyHint: string;
  children: () => ReactNode;
}) {
  const t = useT();
  if (isPending) return <PanelEmpty hint={t("common.loading")} />;
  if (isError) return <PanelEmpty hint={errorHint} />;
  if (isEmpty) return <PanelEmpty hint={emptyHint} />;
  return <>{children()}</>;
}

/** hideOthers 토글 시 현재 심볼 행만. symbolOf는 모듈 레벨 함수로 (memo 보존). */
export function useSymbolRows<T>(
  data: T[] | undefined,
  hideOthers: boolean,
  symbol: string,
  symbolOf: (row: T) => string | null,
): T[] {
  return useMemo(() => {
    const rows = data ?? [];
    return hideOthers ? rows.filter((r) => symbolOf(r) === symbol) : rows;
  }, [data, hideOthers, symbol, symbolOf]);
}

/** 체결 내역 컬럼 라벨 — 호출부가 번역해 주입. 미지정 시 영어 기본값. */
export interface MyTradeColumnLabels {
  date: string;
  side: string;
  price: string;
  qty: string;
  fee: string;
  role: string;
  maker: string;
  taker: string;
}

const DEFAULT_MY_TRADE_LABELS: MyTradeColumnLabels = {
  date: "Date",
  side: "Side",
  price: "Price",
  qty: "Qty",
  fee: "Fee",
  role: "Role",
  maker: "Maker",
  taker: "Taker",
};

// 체결 내역 컬럼은 양 시장 동일 (첫 컬럼 라벨만 Pair/Symbol)
export function myTradeColumns(
  pairHeader: string,
  labels: MyTradeColumnLabels = DEFAULT_MY_TRADE_LABELS,
): PanelColumn<MyTrade>[] {
  return [
    { key: "date", header: labels.date, tdClass: "text-text-dim", cell: (t) => formatDateTime(t.time) },
    { key: "pair", header: pairHeader, tdClass: "text-text", cell: (t) => t.symbol },
    {
      key: "side",
      header: labels.side,
      tdClass: (t) => (t.isBuyer ? "text-up" : "text-down"),
      cell: (t) => (t.isBuyer ? "BUY" : "SELL"),
    },
    { key: "price", header: labels.price, tdClass: "text-text", cell: (t) => t.price },
    { key: "qty", header: labels.qty, tdClass: "text-text", cell: (t) => t.qty },
    {
      key: "fee",
      header: labels.fee,
      tdClass: "text-text",
      cell: (t) => (
        <>
          {t.commission}
          {t.commissionAsset ? ` ${t.commissionAsset}` : ""}
        </>
      ),
    },
    {
      key: "role",
      header: labels.role,
      tdClass: "text-text-dim",
      cell: (t) => (t.isMaker ? labels.maker : labels.taker),
    },
  ];
}

/** self-trade는 maker/taker 두 행이 같은 trade id를 공유한다. */
export function myTradeRowKey(t: MyTrade): string {
  return `${t.id}:${t.isMaker}`;
}

export interface PanelTabDef<K extends string> {
  key: K;
  label: string;
  /** 라벨 옆 카운트 배지 — undefined면 미표시. */
  count?: number;
}

/** 하단 패널 셸 — 탭 스트립 + hideOthers 토글 + 액션 에러 스트립. */
export function PositionsPanelShell<K extends string>({
  tabs,
  active,
  onSelect,
  hideOthers,
  onHideOthersChange,
  hideOthersLabel,
  headerExtra,
  banner,
  actionError,
  children,
}: {
  tabs: PanelTabDef<K>[];
  active: K;
  onSelect: (key: K) => void;
  hideOthers: boolean;
  onHideOthersChange: (v: boolean) => void;
  hideOthersLabel: string;
  /** 토글 우측 추가 액션 (spot: Cancel All). */
  headerExtra?: ReactNode;
  /** 탭 아래 전체폭 알림 (futures: MARGIN_CALL). */
  banner?: ReactNode;
  actionError: string | null;
  children: ReactNode;
}) {
  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="flex items-center border-b border-line h-8 shrink-0 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => onSelect(t.key)}
            className={`px-3 h-full text-[12px] inline-flex items-center gap-1 border-b-2 -mb-px whitespace-nowrap shrink-0 ${
              t.key === active
                ? "text-text font-medium border-accent"
                : "text-text-dim hover:text-text border-transparent"
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="text-[10px] text-text-muted tnum">({t.count})</span>
            )}
          </button>
        ))}
        <div className="flex-1 min-w-4" />
        <div className="pr-3 flex items-center gap-3 shrink-0">
          <label className="flex items-center gap-1 text-[11px] text-text-dim whitespace-nowrap cursor-pointer">
            <input
              type="checkbox"
              className="w-3 h-3"
              checked={hideOthers}
              onChange={(e) => onHideOthersChange(e.target.checked)}
            />
            {hideOthersLabel}
          </label>
          {headerExtra}
        </div>
      </div>
      {banner}
      {actionError && (
        <div className="px-3 py-1 text-[11px] text-down border-b border-line shrink-0">
          {actionError}
        </div>
      )}
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
