"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/provider";

const STORAGE_KEY = "bts.preferences";

type NumberFormat = "default" | "compact";

interface Preferences {
  confirmBeforeOrder: boolean;
  hideZeroBalances: boolean;
  numberFormat: NumberFormat;
}

const DEFAULTS: Preferences = {
  confirmBeforeOrder: true,
  hideZeroBalances: false,
  numberFormat: "default",
};

// SSR-safe: guards window access so it can run in a lazy state initializer.
// The (app) layout gates /account behind auth, so this only mounts client-side.
function readPreferences(): Preferences {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      confirmBeforeOrder:
        typeof parsed.confirmBeforeOrder === "boolean"
          ? parsed.confirmBeforeOrder
          : DEFAULTS.confirmBeforeOrder,
      hideZeroBalances:
        typeof parsed.hideZeroBalances === "boolean"
          ? parsed.hideZeroBalances
          : DEFAULTS.hideZeroBalances,
      numberFormat:
        parsed.numberFormat === "compact" || parsed.numberFormat === "default"
          ? parsed.numberFormat
          : DEFAULTS.numberFormat,
    };
  } catch (err) {
    console.error("[preferences] failed to read localStorage", err);
    return DEFAULTS;
  }
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-line-strong"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-bg transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function Row({
  label,
  hint,
  control,
  last,
}: {
  label: string;
  hint: string;
  control: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between px-3 py-2.5 ${
        last ? "" : "border-b border-line"
      }`}
    >
      <div>
        <p className="text-[12px] text-text">{label}</p>
        <p className="text-[11px] text-text-dim mt-0.5">{hint}</p>
      </div>
      {control}
    </div>
  );
}

export default function PreferencesPage() {
  const t = useT();
  const [prefs, setPrefs] = useState<Preferences>(readPreferences);

  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (err) {
        console.error("[preferences] failed to write localStorage", err);
      }
      return next;
    });
  }

  return (
    <div>
      <h2 className="text-[13px] font-medium mb-2">{t("account.preferences.title")}</h2>
      <p className="text-[11px] text-text-dim mb-2">
        {t("account.preferences.localNote")}
      </p>

      <div className="bg-surface border border-line">
        <Row
          label={t("account.preferences.confirmOrder.label")}
          hint={t("account.preferences.confirmOrder.hint")}
          control={
            <Toggle
              checked={prefs.confirmBeforeOrder}
              onChange={(v) => update("confirmBeforeOrder", v)}
              label={t("account.preferences.confirmOrder.label")}
            />
          }
        />
        <Row
          label={t("account.preferences.hideZero.label")}
          hint={t("account.preferences.hideZero.hint")}
          control={
            <Toggle
              checked={prefs.hideZeroBalances}
              onChange={(v) => update("hideZeroBalances", v)}
              label={t("account.preferences.hideZero.label")}
            />
          }
        />
        <Row
          label={t("account.preferences.numberFormat.label")}
          hint={t("account.preferences.numberFormat.hint")}
          last
          control={
            <select
              value={prefs.numberFormat}
              onChange={(e) => update("numberFormat", e.target.value as NumberFormat)}
              aria-label={t("account.preferences.numberFormat.label")}
              className="h-7 bg-raised border border-line px-2 text-[12px] text-text focus:outline-none focus:border-accent"
            >
              <option value="default">{t("account.preferences.numberFormat.default")}</option>
              <option value="compact">{t("account.preferences.numberFormat.compact")}</option>
            </select>
          }
        />
      </div>
    </div>
  );
}
