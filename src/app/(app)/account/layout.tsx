"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/provider";

const SUB_NAV = [
  { href: "/account", labelKey: "account.nav.profile" },
  { href: "/account/security", labelKey: "account.nav.security" },
  { href: "/account/api-keys", labelKey: "account.nav.apiManagement" },
  { href: "/account/preferences", labelKey: "account.nav.preferences" },
];

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="px-3 py-3 max-w-[1200px] w-full mx-auto">
      <h1 className="text-[15px] font-semibold mb-3">{t("account.title")}</h1>
      <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-4">
        <aside className="md:border-r md:border-line md:pr-3">
          <nav className="flex md:flex-col gap-0.5 overflow-x-auto">
            {SUB_NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="px-2.5 h-8 inline-flex items-center text-[12px] text-text-dim hover:text-text hover:bg-raised shrink-0"
              >
                {t(n.labelKey)}
              </Link>
            ))}
          </nav>
        </aside>
        <section>{children}</section>
      </div>
    </div>
  );
}
