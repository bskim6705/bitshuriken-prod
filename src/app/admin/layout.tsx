"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import Link from "next/link";
import { TopNav } from "@/components/layout/top-nav";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useT } from "@/lib/i18n/provider";

const SUB_NAV = [
  { href: "/admin", labelKey: "admin.nav.dashboard" },
  { href: "/admin/users", labelKey: "admin.nav.users" },
  { href: "/admin/markets", labelKey: "admin.nav.markets" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  const { data: user, isLoading } = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();
  const isAdmin = user?.role === "ADMIN";

  useEffect(() => {
    if (isLoading) return;
    if (user === null) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    } else if (!isAdmin) {
      router.replace("/");
    }
  }, [isLoading, user, isAdmin, router, pathname]);

  // 서버 AdminGuard가 실제 강제. 이 게이트는 UX용(미인증/비관리자 즉시 리다이렉트).
  if (isLoading || !isAdmin) {
    return (
      <div className="min-h-screen flex flex-col bg-bg">
        <TopNav />
        <main className="flex-1 flex items-center justify-center">
          <p className="text-[12px] text-text-dim">{isLoading ? t("common.loading") : t("admin.redirecting")}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-bg">
      <TopNav />
      <main className="flex-1 flex flex-col">
        <div className="px-3 py-3 max-w-[1200px] w-full mx-auto">
          <h1 className="text-[15px] font-semibold mb-3">{t("admin.title")}</h1>
          <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-4">
            <aside className="md:border-r md:border-line md:pr-3">
              <nav className="flex md:flex-col gap-0.5 overflow-x-auto">
                {SUB_NAV.map((n) => {
                  const active = n.href === "/admin" ? pathname === "/admin" : pathname.startsWith(n.href);
                  return (
                    <Link
                      key={n.href}
                      href={n.href}
                      aria-current={active ? "page" : undefined}
                      className={`px-2.5 h-8 inline-flex items-center text-[12px] shrink-0 ${
                        active
                          ? "text-text bg-raised border-l-2 border-accent"
                          : "text-text-dim hover:text-text hover:bg-raised"
                      }`}
                    >
                      {t(n.labelKey)}
                    </Link>
                  );
                })}
              </nav>
            </aside>
            <section>{children}</section>
          </div>
        </div>
      </main>
    </div>
  );
}
