"use client";

import { useEffect, useRef, useState } from "react";

export const NUMERIC_RE = /^\d*\.?\d*$/;

export function isPos(v: string): boolean {
  return v !== "" && NUMERIC_RE.test(v) && Number(v) > 0;
}

export function decimalsOf(v: string): number {
  const i = v.indexOf(".");
  return i === -1 ? 0 : v.length - i - 1;
}

/** 제출 직전 trailing dot 제거 ("5." → "5"). */
export function normDecimal(v: string): string {
  return v.endsWith(".") ? v.slice(0, -1) : v;
}

/** 주문 폼 공통 상태 — 탭/에러/성공 플래시, 숫자 입력 가드, 제출 래퍼. */
export function useOrderFormState<T extends string>(initialTab: T) {
  const [tab, setTab] = useState<T>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const flashTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  function clearStatus() {
    setError(null);
    setFlash(false);
  }

  function switchTab(key: T) {
    setTab(key);
    clearStatus();
  }

  function showFlash() {
    setFlash(true);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlash(false), 2500);
  }

  /** NUMERIC_RE 통과 시에만 반영 + 상태 클리어 (+시장별 후처리). */
  function numericHandler(set: (v: string) => void, after?: (v: string) => void) {
    return (v: string) => {
      if (!NUMERIC_RE.test(v)) return;
      set(v);
      clearStatus();
      after?.(v);
    };
  }

  /** 검증 → 액션(주문 + 입력 리셋) → 성공 플래시. 실패 시 BE 메시지 그대로 노출. */
  async function submitGuarded(
    validate: () => string | null,
    action: () => Promise<void>,
  ): Promise<void> {
    setFlash(false);
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    try {
      await action();
      showFlash();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Order failed");
    }
  }

  return {
    tab,
    switchTab,
    error,
    setError,
    flash,
    clearStatus,
    numericHandler,
    submitGuarded,
  };
}
