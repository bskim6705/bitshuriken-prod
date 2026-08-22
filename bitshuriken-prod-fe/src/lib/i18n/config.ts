// 지원 로케일과 브라우저 언어 감지. 라우팅 없이 클라이언트에서 로케일을 결정한다.
export const LOCALES = ["en", "ko", "ja", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

// 스위처/드롭다운에 노출하는 자국어 표기.
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  ko: "한국어",
  ja: "日本語",
  zh: "中文",
};

export const LOCALE_STORAGE_KEY = "bitshuriken_locale";

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

// navigator.languages("ko-KR" 등)를 베이스 서브태그로 잘라 지원 로케일과 매칭. 없으면 기본값.
export function detectBrowserLocale(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const candidates = navigator.languages?.length
    ? navigator.languages
    : [navigator.language];
  for (const tag of candidates) {
    const base = tag?.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
