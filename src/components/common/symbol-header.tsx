"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { formatPct, formatPrice, priceTone, type PriceTone } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";

function toneClass(tone: PriceTone): string {
  return tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text-dim";
}

export interface PairRowData {
  symbol: string;
  /** 첫 컬럼 표시 (spot: base/quote, futures: symbol + Perp). */
  primary: ReactNode;
  lastPrice: string | null;
  pct: string | null;
}

/** 페어 선택 드롭다운 셸 — 검색창/리스트 상태/행 렌더 공통. 필터링은 호출부 소관. */
export function PairSelectorFrame({
  current,
  onClose,
  placeholder,
  search,
  onSearchChange,
  filterTabs,
  loading,
  rows,
  hrefFor,
}: {
  current: string;
  onClose: () => void;
  placeholder: string;
  search: string;
  onSearchChange: (v: string) => void;
  /** 검색창과 리스트 사이 행 (spot quote 탭). */
  filterTabs?: ReactNode;
  loading: boolean;
  rows: PairRowData[];
  hrefFor: (symbol: string) => string;
}) {
  const t = useT();
  const router = useRouter();

  return (
    <div className="absolute left-0 top-full z-50 w-80 bg-surface border border-line shadow-lg">
      <div className="p-2 border-b border-line">
        <input
          type="search"
          autoFocus
          aria-label={placeholder}
          placeholder={placeholder}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-7 w-full bg-raised border border-line px-2 text-[12px] placeholder:text-text-muted focus:outline-none focus:border-accent"
        />
      </div>
      {filterTabs}
      <div className="max-h-72 overflow-y-auto">
        {loading && (
          <p className="px-3 py-6 text-center text-[11px] text-text-muted">{t("common.loading")}</p>
        )}
        {!loading && rows.length === 0 && (
          <p className="px-3 py-6 text-center text-[11px] text-text-muted">{t("widgets.pairSelector.noResults")}</p>
        )}
        {rows.map((r) => {
          const tone = priceTone(r.pct);
          return (
            <button
              key={r.symbol}
              onClick={() => {
                onClose();
                if (r.symbol !== current) router.push(hrefFor(r.symbol));
              }}
              className={`w-full grid grid-cols-[1fr_auto_auto] gap-3 items-center px-3 h-8 text-[12px] text-left hover:bg-raised ${
                r.symbol === current ? "bg-raised" : ""
              }`}
            >
              {r.primary}
              <span className="tnum text-text-dim">{formatPrice(r.lastPrice)}</span>
              <span className={`tnum w-16 text-right ${toneClass(tone)}`}>
                {formatPct(r.pct, { signed: true })}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface HeaderStat {
  label: string;
  value: string;
  tone?: PriceTone;
}

interface SymbolHeaderTicker {
  lastPrice: string | null;
  priceChangePct24h: string | null;
}

/** 심볼 헤더 바 — 페어 토글/드롭다운 dismiss/가격 블록/스탯 공통. */
export function SymbolHeaderFrame({
  ticker,
  title,
  usdApprox,
  stats,
  renderSelector,
}: {
  ticker: SymbolHeaderTicker | null;
  /** 토글 버튼 내부 (chevron 제외). */
  title: ReactNode;
  /** ≈ $ 보조 줄 표시 여부 (spot: USD-quote 한정, futures: 항상). */
  usdApprox: boolean;
  stats: HeaderStat[];
  renderSelector: (onClose: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 외부 클릭 / Escape로 닫기
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const tone = priceTone(ticker?.priceChangePct24h ?? null);
  const toneCls = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text";

  return (
    // 바깥은 overflow visible 유지 — 그래야 페어 드롭다운(absolute)이 잘리지 않는다.
    // 가로 스크롤은 가격+스탯 내부 래퍼에만 둔다.
    <div className="flex items-center gap-5 px-3 h-12 border-b border-line bg-bg">
      <div ref={containerRef} className="relative h-full shrink-0">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex items-center gap-1.5 pr-3 border-r border-line h-full hover:text-accent"
        >
          {title}
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`text-text-dim transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {open && renderSelector(() => setOpen(false))}
      </div>
      <div className="flex items-center gap-5 min-w-0 overflow-x-auto">
        <div className="flex flex-col shrink-0 leading-tight">
          <span className={`text-[15px] font-semibold tnum ${toneCls}`}>
            {formatPrice(ticker?.lastPrice ?? null)}
          </span>
          {usdApprox && (
            <span className="text-[11px] text-text-dim tnum">
              {ticker?.lastPrice ? `≈ $ ${ticker.lastPrice}` : "≈ $ —"}
            </span>
          )}
        </div>
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col shrink-0 leading-tight">
            <span className="text-[10px] text-text-dim">{s.label}</span>
            <span
              className={`text-[12px] tnum ${
                s.tone === "up"
                  ? "text-up"
                  : s.tone === "down"
                  ? "text-down"
                  : "text-text"
              }`}
            >
              {s.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
