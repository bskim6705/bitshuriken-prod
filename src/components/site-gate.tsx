"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { LanguageSwitcher } from "@/components/ui/language-switcher";

// 완성 전 임시 접근 차단. 비밀번호가 localStorage에 저장돼 있지 않으면
// 어떤 페이지도 렌더하지 않아 API 요청 자체가 발생하지 않는다.
const GATE_KEY = "bitshuriken_gate";
const GATE_PASSWORD = "winteriscoming";

const gateListeners = new Set<() => void>();

function subscribeGate(cb: () => void) {
  gateListeners.add(cb);
  // 다른 탭의 변경 + 같은 탭의 수동 emit 모두 수신.
  window.addEventListener("storage", cb);
  return () => {
    gateListeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function isUnlocked() {
  return window.localStorage.getItem(GATE_KEY) === GATE_PASSWORD;
}

function unlock() {
  window.localStorage.setItem(GATE_KEY, GATE_PASSWORD);
  // 같은 탭에서는 storage 이벤트가 안 뜨므로 구독자에게 직접 알린다.
  gateListeners.forEach((cb) => cb());
}

// SSR/하이드레이션 동안 false, 마운트 후 true — localStorage 판단 전에 깜빡임을 막는다.
const noopSubscribe = () => () => {};

export function SiteGate({ children }: { children: React.ReactNode }) {
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const unlocked = useSyncExternalStore(subscribeGate, isUnlocked, () => false);

  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  // 첫 페인트에서는 localStorage를 모르므로 아무것도 그리지 않는다.
  if (!hydrated) return null;
  if (unlocked) return <>{children}</>;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (input === GATE_PASSWORD) {
      unlock();
      return;
    }
    setError(true);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-line bg-surface p-6"
      >
        <div className="flex items-start justify-between gap-2">
          <h1 className="text-text text-base font-semibold">Bitshuriken</h1>
          <LanguageSwitcher variant="inline" />
        </div>
        <p className="text-text-dim mt-1 text-xs">{t("gate.subtitle")}</p>
        <input
          type="password"
          autoFocus
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (error) setError(false);
          }}
          placeholder={t("gate.password")}
          className="text-text mt-4 w-full rounded border border-line bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
        />
        {error && <p className="text-down mt-2 text-xs">{t("gate.error")}</p>}
        <button
          type="submit"
          className="bg-accent hover:bg-accent-hover mt-4 w-full rounded px-3 py-2 text-sm font-semibold text-[#0b0e11]"
        >
          {t("gate.submit")}
        </button>
      </form>
    </main>
  );
}
