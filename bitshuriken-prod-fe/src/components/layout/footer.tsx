"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/provider";

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
          <span className="tnum">v2.0.0-dev</span>
        </div>
      </div>
    </footer>
  );
}
