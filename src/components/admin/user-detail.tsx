"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useAdminUser, useRevokeApiKey, useUpdateFee } from "@/lib/hooks/use-admin";
import { BalanceAdjustDialog } from "@/components/admin/balance-adjust-dialog";
import { AccountActions } from "@/components/admin/account-actions";
import { useT } from "@/lib/i18n/provider";
import type { AdminUserDetail } from "@/lib/types/admin";

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1.5">
        <h3 className="text-[12px] font-medium">
          {title}
          {count != null && <span className="text-text-muted ml-1.5">({count})</span>}
        </h3>
        {action}
      </div>
      <div className="bg-surface border border-line overflow-x-auto">{children}</div>
    </div>
  );
}

function Th({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <th className={`font-normal px-3 py-1.5 text-[11px] text-text-dim ${first ? "text-left" : "text-right"}`}>
      {children}
    </th>
  );
}

function Empty({ cols, label }: { cols: number; label: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-6 text-center text-[11px] text-text-muted">
        {label}
      </td>
    </tr>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] text-text-dim">{label}</dt>
      <dd className="text-[12px] mt-0.5">{value}</dd>
    </div>
  );
}

function FeeEditor({ userId, makerBps, takerBps }: { userId: string; makerBps: number; takerBps: number }) {
  const t = useT();
  const { data: admin } = useCurrentUser();
  const update = useUpdateFee(userId);
  const [editing, setEditing] = useState(false);
  const [maker, setMaker] = useState(String(makerBps));
  const [taker, setTaker] = useState(String(takerBps));
  const [totp, setTotp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsTotp = admin?.twoFactorEnabled === true;

  function start() {
    setMaker(String(makerBps));
    setTaker(String(takerBps));
    setTotp("");
    setError(null);
    setEditing(true);
  }

  async function save() {
    setError(null);
    const m = Number(maker);
    const tk = Number(taker);
    if (!Number.isInteger(m) || m < 0 || m > 9999 || !Number.isInteger(tk) || tk < 0 || tk > 9999) {
      setError(t("admin.userDetail.fee.bpsError"));
      return;
    }
    try {
      await update.mutateAsync({
        feeMakerBps: m,
        feeTakerBps: tk,
        ...(needsTotp && totp ? { totpCode: totp } : {}),
      });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.userDetail.fee.updateFailed"));
    }
  }

  if (!editing) {
    return (
      <span className="tnum">
        {makerBps} / {takerBps}
        <button type="button" onClick={start} className="text-accent hover:underline ml-2 text-[11px]">
          {t("common.edit")}
        </button>
      </span>
    );
  }

  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-1 flex-wrap">
        <input
          value={maker}
          onChange={(e) => setMaker(e.target.value.replace(/\D/g, ""))}
          className="w-12 h-6 bg-raised border border-line px-1 text-[11px] tnum text-right focus:outline-none focus:border-accent"
        />
        <span className="text-text-muted">/</span>
        <input
          value={taker}
          onChange={(e) => setTaker(e.target.value.replace(/\D/g, ""))}
          className="w-12 h-6 bg-raised border border-line px-1 text-[11px] tnum text-right focus:outline-none focus:border-accent"
        />
        {needsTotp && (
          <input
            value={totp}
            onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="2FA"
            className="w-14 h-6 bg-raised border border-line px-1 text-[11px] tnum focus:outline-none focus:border-accent"
          />
        )}
        <button
          type="button"
          onClick={save}
          disabled={update.isPending}
          className="text-up hover:underline text-[11px] disabled:opacity-40"
        >
          {update.isPending ? "…" : t("common.save")}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="text-text-dim hover:text-text text-[11px]"
        >
          {t("common.cancel")}
        </button>
      </span>
      {error && <span className="text-[10px] text-down">{error}</span>}
    </span>
  );
}

function RevokeCell({ userId, apiKeyId, revoked }: { userId: string; apiKeyId: string; revoked: boolean }) {
  const t = useT();
  const { data: admin } = useCurrentUser();
  const revoke = useRevokeApiKey(userId);
  const [confirming, setConfirming] = useState(false);
  const [totp, setTotp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsTotp = admin?.twoFactorEnabled === true;

  if (revoked) return <span className="text-down">{t("admin.userDetail.apiKey.revoked")}</span>;

  async function doRevoke() {
    setError(null);
    try {
      await revoke.mutateAsync({ apiKeyId, ...(needsTotp && totp ? { totpCode: totp } : {}) });
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.userDetail.apiKey.revokeFailed"));
    }
  }

  if (!confirming) {
    return (
      <span className="inline-flex items-center gap-2 justify-end">
        <span className="text-up">{t("admin.userDetail.apiKey.active")}</span>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="text-down hover:underline text-[11px]"
        >
          {t("admin.userDetail.apiKey.revoke")}
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 justify-end flex-wrap">
      {needsTotp && (
        <input
          value={totp}
          onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="2FA"
          className="w-14 h-6 bg-raised border border-line px-1 text-[11px] tnum focus:outline-none focus:border-accent"
        />
      )}
      <button
        type="button"
        onClick={doRevoke}
        disabled={revoke.isPending}
        className="text-down hover:underline text-[11px] disabled:opacity-40"
      >
        {revoke.isPending ? "…" : t("common.confirm")}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-text-dim hover:text-text text-[11px]"
      >
        {t("admin.users.no")}
      </button>
      {error && <span className="text-[10px] text-down w-full text-right">{error}</span>}
    </span>
  );
}

function Summary({ userId, user }: { userId: string; user: AdminUserDetail["user"] }) {
  const t = useT();
  return (
    <div className="bg-surface border border-line p-3 mb-4">
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Field label={t("admin.userDetail.summary.email")} value={user.email} />
        <Field
          label={t("admin.userDetail.summary.role")}
          value={user.role === "ADMIN" ? <span className="text-accent">ADMIN</span> : "USER"}
        />
        <Field label={t("admin.userDetail.summary.displayName")} value={user.displayName ?? <span className="text-text-muted">—</span>} />
        <Field
          label={t("admin.userDetail.summary.emailVerified")}
          value={user.emailVerified ? t("admin.users.yes") : <span className="text-text-muted">{t("admin.users.no")}</span>}
        />
        <Field label={t("admin.userDetail.summary.twoFactor")} value={user.twoFactorEnabled ? t("admin.users.on") : <span className="text-text-muted">{t("admin.users.off")}</span>} />
        <Field
          label={t("admin.userDetail.summary.makerTakerBps")}
          value={<FeeEditor userId={userId} makerBps={user.feeMakerBps} takerBps={user.feeTakerBps} />}
        />
        <Field label={t("admin.userDetail.summary.created")} value={<span className="tnum">{fmtDate(user.createdAt)}</span>} />
        <Field label={t("admin.userDetail.summary.userId")} value={<span className="text-text-dim text-[11px] break-all">{user.id}</span>} />
      </dl>
    </div>
  );
}

export function UserDetail({ userId }: { userId: string }) {
  const t = useT();
  const { data, isLoading, error } = useAdminUser(userId);
  const [adjustOpen, setAdjustOpen] = useState(false);

  return (
    <div>
      <div className="mb-3">
        <Link href="/admin/users" className="text-[11px] text-accent hover:underline">
          {t("admin.userDetail.backToUsers")}
        </Link>
      </div>

      {isLoading && <p className="text-[12px] text-text-dim">{t("common.loading")}</p>}
      {!isLoading && error && (
        <p className="text-[12px] text-down">
          {error instanceof Error ? error.message : t("admin.userDetail.loadError")}
        </p>
      )}

      {!isLoading && !error && data && (
        <>
          <Summary userId={userId} user={data.user} />

          <AccountActions user={data.user} />

          <Section
            title={t("admin.userDetail.wallets")}
            count={data.wallets.length}
            action={
              <Button variant="primary" size="sm" onClick={() => setAdjustOpen(true)}>
                {t("admin.userDetail.adjustBalance")}
              </Button>
            }
          >
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th first>{t("common.asset")}</Th>
                  <Th>{t("admin.userDetail.wallets.market")}</Th>
                  <Th>{t("common.balance")}</Th>
                  <Th>{t("admin.userDetail.wallets.locked")}</Th>
                </tr>
              </thead>
              <tbody>
                {data.wallets.length === 0 && <Empty cols={4} label={t("admin.userDetail.wallets.empty")} />}
                {data.wallets.map((w) => (
                  <tr key={`${w.marketType}-${w.assetSymbol}`} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 text-left">{w.assetSymbol}</td>
                    <td className="px-3 py-2 text-right text-text-dim">{w.marketType}</td>
                    <td className="px-3 py-2 text-right tnum">{w.balance}</td>
                    <td className="px-3 py-2 text-right tnum text-text-dim">{w.locked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title={t("admin.userDetail.positions")} count={data.positions.length}>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th first>{t("admin.userDetail.positions.symbol")}</Th>
                  <Th>{t("admin.userDetail.positions.qty")}</Th>
                  <Th>{t("admin.userDetail.positions.entry")}</Th>
                  <Th>{t("admin.userDetail.positions.margin")}</Th>
                  <Th>{t("admin.userDetail.positions.lev")}</Th>
                  <Th>{t("admin.userDetail.positions.mode")}</Th>
                  <Th>{t("common.status")}</Th>
                </tr>
              </thead>
              <tbody>
                {data.positions.length === 0 && <Empty cols={7} label={t("admin.userDetail.positions.empty")} />}
                {data.positions.map((p) => (
                  <tr key={p.tickerSymbol} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 text-left">{p.tickerSymbol}</td>
                    <td className="px-3 py-2 text-right tnum">{p.qty}</td>
                    <td className="px-3 py-2 text-right tnum">{p.entryPrice}</td>
                    <td className="px-3 py-2 text-right tnum">{p.isolatedMargin}</td>
                    <td className="px-3 py-2 text-right tnum">{p.leverage}x</td>
                    <td className="px-3 py-2 text-right text-text-dim">{p.marginMode}</td>
                    <td className="px-3 py-2 text-right text-text-dim">{p.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title={t("admin.userDetail.orders")} count={data.openOrders.length}>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th first>{t("admin.userDetail.orders.symbol")}</Th>
                  <Th>{t("admin.userDetail.orders.market")}</Th>
                  <Th>{t("common.type")}</Th>
                  <Th>{t("common.side")}</Th>
                  <Th>{t("common.price")}</Th>
                  <Th>{t("admin.userDetail.positions.qty")}</Th>
                  <Th>{t("admin.userDetail.orders.filled")}</Th>
                  <Th>{t("common.status")}</Th>
                  <Th>{t("admin.userDetail.orders.created")}</Th>
                </tr>
              </thead>
              <tbody>
                {data.openOrders.length === 0 && <Empty cols={9} label={t("admin.userDetail.orders.empty")} />}
                {data.openOrders.map((o) => (
                  <tr key={o.id} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 text-left">{o.tickerSymbol}</td>
                    <td className="px-3 py-2 text-right text-text-dim">{o.tickerMarket}</td>
                    <td className="px-3 py-2 text-right">{o.type}</td>
                    <td className={`px-3 py-2 text-right ${o.side === "BUY" ? "text-up" : "text-down"}`}>
                      {o.side}
                    </td>
                    <td className="px-3 py-2 text-right tnum">{o.price ?? "—"}</td>
                    <td className="px-3 py-2 text-right tnum">{o.origQty ?? "—"}</td>
                    <td className="px-3 py-2 text-right tnum text-text-dim">{o.executedQty}</td>
                    <td className="px-3 py-2 text-right text-text-dim">{o.status}</td>
                    <td className="px-3 py-2 text-right tnum text-text-dim">{fmtDate(o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title={t("admin.userDetail.transactions")} count={data.recentTransactions.length}>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th first>{t("common.type")}</Th>
                  <Th>{t("common.asset")}</Th>
                  <Th>{t("admin.userDetail.transactions.qty")}</Th>
                  <Th>{t("admin.userDetail.transactions.from")}</Th>
                  <Th>{t("admin.userDetail.transactions.to")}</Th>
                  <Th>{t("admin.userDetail.transactions.reason")}</Th>
                  <Th>{t("common.time")}</Th>
                </tr>
              </thead>
              <tbody>
                {data.recentTransactions.length === 0 && <Empty cols={7} label={t("admin.userDetail.transactions.empty")} />}
                {data.recentTransactions.map((t) => (
                  <tr key={t.id} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 text-left">{t.type}</td>
                    <td className="px-3 py-2 text-right">{t.assetSymbol}</td>
                    <td className="px-3 py-2 text-right tnum">{t.qty}</td>
                    <td className="px-3 py-2 text-right text-text-dim">{t.fromMarket ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-text-dim">{t.toMarket ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-text-dim">{t.reason ?? "—"}</td>
                    <td className="px-3 py-2 text-right tnum text-text-dim">{fmtDate(t.time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title={t("admin.userDetail.apiKeys")} count={data.apiKeys.length}>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th first>{t("admin.userDetail.apiKeys.label")}</Th>
                  <Th>{t("admin.userDetail.apiKeys.apiKey")}</Th>
                  <Th>{t("admin.userDetail.apiKeys.permissions")}</Th>
                  <Th>{t("admin.userDetail.orders.created")}</Th>
                  <Th>{t("admin.userDetail.apiKeys.lastUsed")}</Th>
                  <Th>{t("common.status")}</Th>
                </tr>
              </thead>
              <tbody>
                {data.apiKeys.length === 0 && <Empty cols={6} label={t("admin.userDetail.apiKeys.empty")} />}
                {data.apiKeys.map((k) => (
                  <tr key={k.id} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 text-left">{k.label || "—"}</td>
                    <td className="px-3 py-2 text-right text-text-dim tnum truncate max-w-[180px]" title={k.apiKey}>
                      {k.apiKey}
                    </td>
                    <td className="px-3 py-2 text-right text-text-dim">
                      {[k.canRead && t("admin.userDetail.apiKeys.read"), k.canTrade && t("admin.userDetail.apiKeys.trade")].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="px-3 py-2 text-right tnum text-text-dim">{fmtDate(k.createdAt)}</td>
                    <td className="px-3 py-2 text-right tnum text-text-dim">
                      {k.lastUsedAt ? fmtDate(k.lastUsedAt) : t("admin.userDetail.apiKeys.never")}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <RevokeCell userId={userId} apiKeyId={k.id} revoked={k.revokedAt != null} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {adjustOpen && (
            <BalanceAdjustDialog
              userId={userId}
              userEmail={data.user.email}
              onClose={() => setAdjustOpen(false)}
            />
          )}
        </>
      )}
    </div>
  );
}
