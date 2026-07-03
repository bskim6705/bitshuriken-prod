"use client";

import Link from "next/link";
import { useEffect } from "react";
import { TopNav } from "@/components/layout/top-nav";
import { useT } from "@/lib/i18n/provider";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col">
      <TopNav />
      <main className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <div className="text-down text-[80px] font-bold tnum leading-none tracking-tight">
            500
          </div>
          <h1 className="text-[18px] font-semibold mt-4 mb-2">
            {t("chrome.error.title")}
          </h1>
          <p className="text-[13px] text-text-dim mb-2">
            {t("chrome.error.body")}
          </p>
          {error?.digest && (
            <p className="text-[11px] text-text-muted tnum mb-6">
              {t("chrome.error.ref")} {error.digest}
            </p>
          )}
          <div className="flex gap-2 justify-center">
            <button
              onClick={reset}
              className="h-9 px-4 inline-flex items-center text-[13px] font-medium bg-accent text-bg hover:bg-accent-hover"
            >
              {t("chrome.error.tryAgain")}
            </button>
            <Link
              href="/"
              className="h-9 px-4 inline-flex items-center text-[13px] border border-line-strong text-text hover:bg-raised"
            >
              {t("chrome.error.home")}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
