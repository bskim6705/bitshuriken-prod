"use client";

import { useEffect, useState } from "react";
import { onToast, type AppNotification } from "@/lib/notifications/store";
import { useT } from "@/lib/i18n/provider";

const TOAST_MS = 5000;
const MAX_VISIBLE = 4;

const LEVEL_BORDER: Record<AppNotification["level"], string> = {
  info: "border-l-text-dim",
  success: "border-l-up",
  warning: "border-l-accent",
  error: "border-l-down",
};

/** 새 알림을 우하단에 잠깐 띄우는 토스트 스택. (app) 레이아웃에 1회 마운트. */
export function Toaster() {
  const t = useT();
  const [toasts, setToasts] = useState<AppNotification[]>([]);

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const off = onToast((n) => {
      setToasts((prev) => [n, ...prev].slice(0, MAX_VISIBLE));
      timers.set(
        n.id,
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== n.id));
          timers.delete(n.id);
        }, TOAST_MS),
      );
    });
    return () => {
      off();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  const dismiss = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-72" role="status" aria-live="polite">
      {toasts.map((n) => (
        <div
          key={n.id}
          className={`bg-surface border border-line border-l-2 ${LEVEL_BORDER[n.level]} shadow-lg px-3 py-2.5`}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="text-[12px] text-text">{n.title}</span>
            <button
              type="button"
              aria-label={t("chrome.toaster.dismiss")}
              onClick={() => dismiss(n.id)}
              className="text-text-muted hover:text-text text-[14px] leading-none -mt-0.5"
            >
              ×
            </button>
          </div>
          {n.body && <p className="text-[11px] text-text-dim mt-0.5">{n.body}</p>}
        </div>
      ))}
    </div>
  );
}
