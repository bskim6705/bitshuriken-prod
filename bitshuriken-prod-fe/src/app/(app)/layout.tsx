"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { TopNav } from "@/components/layout/top-nav";
import { Toaster } from "@/components/layout/toaster";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useT } from "@/lib/i18n/provider";

// market(markets/trade/futures)은 비로그인 공개. 로그인은 private 라우트에서만 요구하고,
// 공개 페이지 안의 private 위젯은 각자 GuestCta/enabled 가드로 처리한다.
const PRIVATE_PREFIXES = ["/account", "/orders", "/portfolio", "/wallet"];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  const { data: user, isLoading } = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();
  const isPrivate = PRIVATE_PREFIXES.some((p) => pathname.startsWith(p));

  useEffect(() => {
    if (isPrivate && !isLoading && user === null) {
      const next = encodeURIComponent(pathname);
      router.replace(`/login?next=${next}`);
    }
  }, [isPrivate, isLoading, user, router, pathname]);

  if (isPrivate && (isLoading || user === null)) {
    return (
      <div className="min-h-screen flex flex-col bg-bg">
        <TopNav />
        <main className="flex-1 flex items-center justify-center">
          <p className="text-[12px] text-text-dim">{t("common.loading")}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:bg-accent focus:text-bg focus:px-3 focus:py-1.5 focus:text-[12px] focus:font-medium"
      >
        {t("chrome.shell.skipToContent")}
      </a>
      <TopNav />
      <main id="main" className="flex-1 flex flex-col">
        {children}
      </main>
      <Toaster />
    </div>
  );
}
