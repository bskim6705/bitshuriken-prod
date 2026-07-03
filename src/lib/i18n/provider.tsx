"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  detectBrowserLocale,
  isLocale,
  type Locale,
} from "./config";
import { dictionaries, type TranslationKey } from "./messages";

// 로케일은 localStorage 기반 외부 스토어로 관리한다. useSyncExternalStore로 읽어
// SSR/하이드레이션은 기본 로케일, 마운트 후 저장값/브라우저 언어로 매칭(불일치 경고 없음).
let current: Locale | null = null;
const listeners = new Set<() => void>();

function resolveLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return isLocale(stored) ? stored : detectBrowserLocale();
}

function getSnapshot(): Locale {
  if (current === null) current = resolveLocale();
  return current;
}

function getServerSnapshot(): Locale {
  return DEFAULT_LOCALE;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // 다른 탭의 변경 수신.
  const onStorage = (e: StorageEvent) => {
    if (e.key === LOCALE_STORAGE_KEY) {
      current = resolveLocale();
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function persistLocale(next: Locale) {
  current = next;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
  }
  // 같은 탭은 storage 이벤트가 안 뜨므로 직접 알린다.
  listeners.forEach((cb) => cb());
}

// 알려진 키는 자동완성되고, 데이터에서 동적으로 만든 키(예: labelKey)도 허용한다.
// 미존재 키는 런타임에서 en → 키 문자열 순으로 폴백한다.
type Translate = (
  key: TranslationKey | (string & {}),
  vars?: Record<string, string | number>,
) => string;

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const locale = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // <html lang>을 활성 로케일과 동기화.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback<Translate>(
    (key, vars) => {
      const dict = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE];
      const k = key as TranslationKey;
      let out = dict[k] ?? dictionaries[DEFAULT_LOCALE][k] ?? key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          out = out.replaceAll(`{${name}}`, String(value));
        }
      }
      return out;
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale: persistLocale, t }),
    [locale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <I18nProvider>");
  return ctx;
}

// 번역 함수만 필요할 때.
export function useT(): Translate {
  return useI18n().t;
}
