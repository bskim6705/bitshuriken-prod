"use client";

import { useEffect, useRef, useState } from "react";
import {
  useNotifications,
  markAllRead,
  clearAll,
  type AppNotification,
} from "@/lib/notifications/store";
import { useT } from "@/lib/i18n/provider";

const ICON_CLS = "w-9 h-9 grid place-items-center text-text-dim hover:text-text hover:bg-raised";

const LEVEL_DOT: Record<AppNotification["level"], string> = {
  info: "bg-text-dim",
  success: "bg-up",
  warning: "bg-accent",
  error: "bg-down",
};

function relativeTime(ts: number, nowLabel: string): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return nowLabel;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function NotificationBell() {
  const t = useT();
  const { items, unread } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 열면 모두 읽음 처리.
  useEffect(() => {
    if (open) markAllRead();
  }, [open]);

  // 바깥 클릭 / Escape로 닫기.
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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={t("chrome.notifications.title")}
        title={t("chrome.notifications.title")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${ICON_CLS} relative`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10 21a2 2 0 0 0 4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute top-1.5 right-1.5 min-w-[14px] h-[14px] px-1 grid place-items-center rounded-full bg-down text-text text-[9px] font-semibold leading-none">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-80 bg-surface border border-line shadow-lg z-50"
        >
          <div className="flex items-center justify-between h-9 px-3 border-b border-line">
            <span className="text-[12px] font-medium text-text">{t("chrome.notifications.title")}</span>
            <button
              type="button"
              onClick={clearAll}
              disabled={items.length === 0}
              className="text-[11px] text-text-dim hover:text-text disabled:opacity-40"
            >
              {t("chrome.notifications.clear")}
            </button>
          </div>

          {items.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-text-muted">{t("chrome.notifications.empty")}</div>
          ) : (
            <ul className="max-h-96 overflow-y-auto divide-y divide-line">
              {items.map((n) => (
                <li key={n.id} className="flex gap-2.5 px-3 py-2.5 hover:bg-raised">
                  <span
                    className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${LEVEL_DOT[n.level]}`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[12px] text-text truncate">{n.title}</span>
                      <time className="text-[10px] text-text-muted shrink-0">{relativeTime(n.ts, t("chrome.notifications.now"))}</time>
                    </div>
                    {n.body && <p className="text-[11px] text-text-dim truncate">{n.body}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
