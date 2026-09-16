"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/provider";
import { APP_VERSION } from "@/lib/version";

export function Footer() {
  const t = useT();
  return (
    <footer className="border-t border-line mt-auto">
      <div className="px-3 py-3 max-w-[1400px] mx-auto flex items-center justify-between text-[11px] text-text-muted">
        <span>{t("chrome.footer.tagline")}</span>
        <div className="flex items-center gap-4">
          <Link href="/markets" className="hover:text-text">{t("chrome.footer.markets")}</Link>
          <Link href="/api-docs" className="hover:text-text">{t("chrome.footer.api")}</Link>
          <Link href="/leaderboard" className="hover:text-text">{t("chrome.footer.leaderboard")}</Link>
          <Link href="/#terms" className="hover:text-text">{t("chrome.footer.terms")}</Link>
          <span className="tnum">{APP_VERSION}</span>
        </div>
      </div>
    </footer>
  );
}
