"use client";

import { useEffect, useRef, useState } from "react";
import { LOCALES, LOCALE_LABELS } from "@/lib/i18n/config";
import { useI18n } from "@/lib/i18n/provider";

const GlobeIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3Z" />
  </svg>
);

type Variant = "nav" | "inline";

/**
 * 로케일 전환 드롭다운. 글로브 아이콘 + 현재 언어 자국어 표기.
 * variant="nav"은 TopNav 아이콘 줄에, "inline"은 게이트/폼 등 라벨이 필요한 곳에.
 */
export function LanguageSwitcher({
  variant = "nav",
  className = "",
}: {
  variant?: Variant;
  className?: string;
}) {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const triggerCls =
    variant === "nav"
      ? "h-9 px-2.5 inline-flex items-center gap-1.5 text-text-dim hover:text-text hover:bg-raised text-[13px]"
      : "h-8 px-2 inline-flex items-center gap-1.5 rounded border border-line text-text-dim hover:text-text text-xs";

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("common.language")}
        title={t("common.language")}
        className={triggerCls}
      >
        <GlobeIcon />
        <span>{LOCALE_LABELS[locale]}</span>
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label={t("common.language")}
          className="absolute right-0 top-full mt-1 min-w-[140px] bg-surface border border-line shadow-lg z-50 py-1"
        >
          {LOCALES.map((l) => {
            const active = l === locale;
            return (
              <li key={l}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    setLocale(l);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-1.5 text-[13px] hover:bg-raised ${
                    active ? "text-text" : "text-text-dim"
                  }`}
                >
                  <span>{LOCALE_LABELS[l]}</span>
                  {active && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
