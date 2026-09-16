"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Wordmark } from "./wordmark";
import { NotificationBell } from "./notification-bell";
import { LanguageSwitcher } from "@/components/ui/language-switcher";
import { useCurrentUser, useLogout } from "@/lib/hooks/use-auth";
import { useNotificationFeed } from "@/lib/notifications/feed";
import { useT } from "@/lib/i18n/provider";
import type { TranslationKey } from "@/lib/i18n/messages";
import { PRODUCT_STAGES, type Product } from "@/lib/product-stages";

type NavItem = { href: string; labelKey: TranslationKey; product?: Product };

// 제품 단계(ADR-076): alpha는 내비에서 제외, beta는 BETA 배지.
const PRIMARY: readonly NavItem[] = [
  { href: "/markets", labelKey: "chrome.nav.markets" },
  { href: "/trade/BTCUSDT", labelKey: "chrome.nav.spot", product: "spot" },
  { href: "/futures/BTCUSDT", labelKey: "chrome.nav.futures", product: "futures" },
  { href: "/leaderboard", labelKey: "chrome.nav.leaderboard" },
  { href: "/fly", labelKey: "chrome.nav.fly" },
];
const VISIBLE = PRIMARY.filter((n) => !n.product || PRODUCT_STAGES[n.product] !== "alpha");

const ICON_CLS =
  "w-9 h-9 grid place-items-center text-text-dim hover:text-text hover:bg-raised";

export function TopNav() {
  const t = useT();
  const { data: user } = useCurrentUser();
  const logout = useLogout();
  const router = useRouter();
  const pathname = usePathname();

  // 로그인 중 user-data WS를 구독해 체결/마진콜 등을 알림으로 적재 (내부에서 비로그인 시 no-op).
  useNotificationFeed();

  const isAuthed = !!user;

  function onLogout() {
    logout.mutate(undefined, {
      onSuccess: () => router.push("/"),
    });
  }

  return (
    <header className="sticky top-0 z-40 bg-bg border-b border-line h-12">
      <div className="flex items-center h-full px-3 gap-1">
        <div className="pr-3 mr-1 border-r border-line h-6 flex items-center">
          <Wordmark />
        </div>
        <nav className="flex items-center">
          {VISIBLE.map((n) => {
            const section = "/" + n.href.split("/")[1];
            const active = pathname === section || pathname.startsWith(section + "/");
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={`px-3 h-12 inline-flex items-center text-[13px] border-b-2 ${
                  active
                    ? "text-text border-accent"
                    : "text-text-dim border-transparent hover:text-text"
                }`}
              >
                {t(n.labelKey)}
                {n.product && PRODUCT_STAGES[n.product] === "beta" ? (
                  <span
                    className="ml-1 text-[9px] leading-none text-accent border border-accent px-1 py-px"
                    title={t("chrome.nav.betaTitle")}
                  >
                    {t("chrome.nav.beta")}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <div className="flex-1" />
        <div className="flex items-center">
          <button aria-label={t("chrome.nav.search")} title={t("chrome.nav.search")} className={ICON_CLS}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </button>
          <LanguageSwitcher />
          {isAuthed ? (
            <>
              <NotificationBell />
              <Link href="/orders" aria-label={t("chrome.nav.orders")} title={t("chrome.nav.orders")} className={ICON_CLS}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 3h8l4 4v14H4V3h4" />
                  <path d="M8 3v4h8V3" />
                  <path d="M8 12h8M8 16h5" />
                </svg>
              </Link>
              <Link href="/wallet" aria-label={t("chrome.nav.wallet")} title={t("chrome.nav.wallet")} className={ICON_CLS}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 7h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12v4" />
                  <circle cx="16" cy="13" r="1.2" fill="currentColor" />
                </svg>
              </Link>
              <Link href="/account" aria-label={t("chrome.nav.account")} title={user.email} className={ICON_CLS}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 21a8 8 0 0 1 16 0" />
                </svg>
              </Link>
              <div className="h-4 w-px bg-line mx-1" />
              <button
                onClick={onLogout}
                disabled={logout.isPending}
                className="h-7 px-3 inline-flex items-center text-[13px] text-text-dim hover:text-text disabled:opacity-50"
              >
                {logout.isPending ? "…" : t("chrome.nav.logOut")}
              </button>
            </>
          ) : (
            <>
              <div className="h-4 w-px bg-line mx-1" />
              <Link
                href="/login"
                className="h-7 px-3 inline-flex items-center text-[13px] text-text-dim hover:text-text"
              >
                {t("chrome.nav.logIn")}
              </Link>
              <Link
                href="/signup"
                className="h-7 px-3 inline-flex items-center text-[13px] font-medium bg-accent text-bg hover:bg-accent-hover"
              >
                {t("chrome.nav.signUp")}
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
