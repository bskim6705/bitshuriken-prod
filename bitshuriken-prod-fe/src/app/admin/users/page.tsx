"use client";

import { useState } from "react";
import Link from "next/link";
import { useAdminUsers } from "@/lib/hooks/use-admin";
import { useT } from "@/lib/i18n/provider";

const COL_KEYS = [
  "admin.users.col.email",
  "admin.users.col.role",
  "admin.users.col.verified",
  "admin.users.col.twoFactor",
  "admin.users.col.makerTakerBps",
  "admin.users.col.orders",
  "admin.users.col.apiKeys",
  "admin.users.col.created",
];
const PAGE_SIZE = 50;

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function AdminUsersPage() {
  const t = useT();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const { data, isLoading, error } = useAdminUsers({
    search: search || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setOffset(0);
    setSearch(searchInput.trim());
  }

  const total = data?.total ?? 0;
  const users = data?.users ?? [];

  return (
    <div>
      <div className="flex items-end justify-between mb-2 gap-3">
        <div>
          <h2 className="text-[13px] font-medium">{t("admin.nav.users")}</h2>
          <p className="text-[11px] text-text-dim mt-0.5">{t("admin.users.totalCount", { count: total })}</p>
        </div>
        <form onSubmit={submitSearch}>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label={t("admin.users.searchAria")}
            placeholder={t("admin.users.searchPlaceholder")}
            className="h-7 px-2 text-[12px] bg-surface border border-line w-[220px] focus:outline-none focus:border-accent"
          />
        </form>
      </div>

      <div className="bg-surface border border-line">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[11px] text-text-dim border-b border-line">
                {COL_KEYS.map((c, i) => (
                  <th
                    key={i}
                    className={`font-normal px-3 py-1.5 ${i === 0 ? "text-left" : "text-right"}`}
                  >
                    {t(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={COL_KEYS.length} className="px-3 py-12 text-center text-[11px] text-text-muted">
                    {t("common.loading")}
                  </td>
                </tr>
              )}
              {!isLoading && error && (
                <tr>
                  <td colSpan={COL_KEYS.length} className="px-3 py-12 text-center text-[11px] text-down">
                    {error instanceof Error ? error.message : t("admin.users.loadError")}
                  </td>
                </tr>
              )}
              {!isLoading && !error && users.length === 0 && (
                <tr>
                  <td colSpan={COL_KEYS.length} className="px-3 py-12 text-center text-[11px] text-text-muted">
                    {t("admin.users.noUsers")}
                  </td>
                </tr>
              )}
              {!isLoading &&
                !error &&
                users.map((u) => (
                  <tr key={u.id} className="border-b border-line last:border-b-0 hover:bg-raised">
                    <td className="px-3 py-2 text-left">
                      <Link href={`/admin/users/${u.id}`} className="text-accent hover:underline">
                        {u.email}
                      </Link>
                      {u.displayName && <span className="text-text-muted ml-1.5">({u.displayName})</span>}
                      {u.restricted && (
                        <span className="ml-1.5 inline-flex items-center px-1.5 h-4 text-[10px] border bg-down/15 border-down/40 text-down align-middle">
                          {t("admin.users.restricted")}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {u.role === "ADMIN" ? (
                        <span className="text-accent">ADMIN</span>
                      ) : (
                        <span className="text-text-dim">USER</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {u.emailVerified ? t("admin.users.yes") : <span className="text-text-muted">{t("admin.users.no")}</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {u.twoFactorEnabled ? t("admin.users.on") : <span className="text-text-muted">{t("admin.users.off")}</span>}
                    </td>
                    <td className="px-3 py-2 text-right tnum">
                      {u.feeMakerBps}/{u.feeTakerBps}
                    </td>
                    <td className="px-3 py-2 text-right tnum">{u.orderCount}</td>
                    <td className="px-3 py-2 text-right tnum">{u.apiKeyCount}</td>
                    <td className="px-3 py-2 text-right text-text-dim tnum">{fmtDate(u.createdAt)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between mt-2 text-[11px] text-text-dim">
        <span className="tnum">
          {total > 0
            ? t("admin.users.pageRange", {
                from: offset + 1,
                to: Math.min(offset + PAGE_SIZE, total),
                total,
              })
            : "—"}
        </span>
        <div className="flex gap-3">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="hover:text-text disabled:opacity-40"
          >
            {t("admin.users.prev")}
          </button>
          <button
            type="button"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="hover:text-text disabled:opacity-40"
          >
            {t("admin.users.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
