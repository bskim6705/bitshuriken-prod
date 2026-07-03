"use client";

import Link from "next/link";
import { Wordmark } from "@/components/layout/wordmark";
import { useT } from "@/lib/i18n/provider";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="min-h-screen flex flex-col">
      <header className="h-14 border-b border-line flex items-center px-4 md:px-8">
        <Wordmark />
      </header>
      <main className="flex-1 grid place-items-center p-6">
        <div className="w-full max-w-[400px] bg-surface border border-line p-6">
          {children}
        </div>
      </main>
      <footer className="py-4 text-center text-[11px] text-text-muted">
        <Link href="/" className="hover:text-text">← {t("auth.backHome")}</Link>
      </footer>
    </div>
  );
}
