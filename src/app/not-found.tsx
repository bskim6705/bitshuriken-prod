"use client";

import Link from "next/link";
import { TopNav } from "@/components/layout/top-nav";
import { useT } from "@/lib/i18n/provider";

export default function NotFound() {
  const t = useT();
  return (
    <div className="min-h-screen flex flex-col">
      <TopNav />
      <main className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <div className="text-accent text-[80px] font-bold tnum leading-none tracking-tight">
            404
          </div>
          <h1 className="text-[18px] font-semibold mt-4 mb-2">{t("chrome.notFound.title")}</h1>
          <p className="text-[13px] text-text-dim mb-6">
            {t("chrome.notFound.body")}
          </p>
          <div className="flex gap-2 justify-center">
            <Link
              href="/"
              className="h-9 px-4 inline-flex items-center text-[13px] font-medium bg-accent text-bg hover:bg-accent-hover"
            >
              {t("chrome.notFound.home")}
            </Link>
            <Link
              href="/markets"
              className="h-9 px-4 inline-flex items-center text-[13px] border border-line-strong text-text hover:bg-raised"
            >
              {t("chrome.notFound.markets")}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
