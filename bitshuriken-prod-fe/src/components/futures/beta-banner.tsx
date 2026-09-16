"use client";

import { useSyncExternalStore } from "react";
import { useT } from "@/lib/i18n/provider";
import { PRODUCT_STAGES } from "@/lib/product-stages";

// 세션당 1회 닫기. 상태의 원천은 sessionStorage이고 React는 useSyncExternalStore로 구독한다 —
// 서버 스냅샷은 "닫힘"이라 하이드레이션 불일치 없이 표시 여부가 클라이언트에서만 결정된다.
const DISMISS_KEY = "bs.futuresBeta.dismissed";
const listeners = new Set<() => void>();
let dismissedInMemory = false; // 저장 불가 환경(프라이빗 모드 등)의 폴백

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function readDismissed(): boolean {
  if (dismissedInMemory) return true;
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function dismiss(): void {
  dismissedInMemory = true;
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // 이 페이지 수명 동안만 닫힌다
  }
  listeners.forEach((cb) => cb());
}

/** 선물 beta 안내 (ADR-076): 알려진 한계를 거래 전에 먼저 보여준다. */
export function FuturesBetaBanner() {
  const t = useT();
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => true);

  if (PRODUCT_STAGES.futures !== "beta" || dismissed) return null;

  return (
    <div
      role="note"
      className="flex items-start gap-3 px-3 py-2 bg-raised border-b border-line text-[12px]"
    >
      <span className="shrink-0 mt-px text-[10px] leading-none text-accent border border-accent px-1 py-px">
        {t("futures.beta.badge")}
      </span>
      <p className="flex-1 text-text-dim">
        <span className="text-text">{t("futures.beta.title")}</span> {t("futures.beta.body")}{" "}
        <span className="text-text-muted">{t("futures.beta.ref")}</span>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("futures.beta.dismiss")}
        className="shrink-0 text-text-muted hover:text-text"
      >
        ×
      </button>
    </div>
  );
}
