"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CreateApiKeyDialog } from "@/components/account/create-api-key-dialog";
import { ApiKeySecretDialog } from "@/components/account/api-key-secret-dialog";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useApiKeys, useRevokeApiKey } from "@/lib/hooks/use-api-keys";
import type { ApiKey, IssuedApiKey } from "@/lib/types/api-key";
import { useT } from "@/lib/i18n/provider";

const COL_KEYS = [
  "account.apiKeys.col.label",
  "account.apiKeys.col.apiKey",
  "account.apiKeys.col.permissions",
  "account.apiKeys.col.ipRestriction",
  "account.apiKeys.col.expires",
  "account.apiKeys.col.created",
  "account.apiKeys.col.lastUsed",
  "",
];

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

function Badge({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center px-1.5 h-4 text-[10px] bg-raised border border-line text-text-dim">
      {children}
    </span>
  );
}

function KeyRow({
  k,
  confirming,
  revoking,
  onAskRevoke,
  onCancelRevoke,
  onConfirmRevoke,
}: {
  k: ApiKey;
  confirming: boolean;
  revoking: boolean;
  onAskRevoke: () => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(k.apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <tr className="border-b border-line last:border-b-0 hover:bg-raised align-top">
      <td className="px-3 py-2 text-left">{k.label || "—"}</td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center justify-end gap-2 max-w-[200px] ml-auto">
          <span className="text-[11px] text-text-dim tnum truncate" title={k.apiKey}>
            {k.apiKey}
          </span>
          <button
            type="button"
            onClick={copyKey}
            className="shrink-0 text-[11px] text-accent hover:underline"
          >
            {copied ? t("common.copied") : t("common.copy")}
          </button>
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="inline-flex gap-1 justify-end">
          {k.canRead && <Badge>{t("account.apiKeys.perm.read")}</Badge>}
          {k.canTrade && <Badge>{t("account.apiKeys.perm.trade")}</Badge>}
          {!k.canRead && !k.canTrade && <span className="text-text-muted">—</span>}
        </div>
      </td>
      <td className="px-3 py-2 text-right text-text-dim tnum">
        {k.ipWhitelist.length ? k.ipWhitelist.join(", ") : "—"}
      </td>
      <td className="px-3 py-2 text-right text-text-dim tnum">
        {k.expiresAt ? formatDateTime(k.expiresAt) : t("account.apiKeys.never")}
      </td>
      <td className="px-3 py-2 text-right text-text-dim tnum">{formatDateTime(k.createdAt)}</td>
      <td className="px-3 py-2 text-right text-text-dim tnum">
        {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : t("account.apiKeys.never")}
      </td>
      <td className="px-3 py-2 text-right">
        {confirming ? (
          <div className="inline-flex items-center gap-2">
            <span className="text-[11px] text-text-dim">{t("account.apiKeys.revokeConfirm")}</span>
            <button
              type="button"
              onClick={onConfirmRevoke}
              disabled={revoking}
              className="text-[11px] text-down hover:underline disabled:opacity-40"
            >
              {revoking ? t("account.apiKeys.revoking") : t("account.apiKeys.yes")}
            </button>
            <button
              type="button"
              onClick={onCancelRevoke}
              disabled={revoking}
              className="text-[11px] text-text-dim hover:text-text disabled:opacity-40"
            >
              {t("account.apiKeys.no")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onAskRevoke}
            className="text-[11px] text-down hover:underline"
          >
            {t("account.apiKeys.revoke")}
          </button>
        )}
      </td>
    </tr>
  );
}

export default function ApiKeysPage() {
  const t = useT();
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const { data: keys, isLoading, error } = useApiKeys();
  const revokeMut = useRevokeApiKey();

  const [createOpen, setCreateOpen] = useState(false);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const signedOut = !authLoading && user == null;
  const loading = authLoading || (user != null && isLoading);

  async function confirmRevoke(id: string) {
    setRevokeError(null);
    try {
      await revokeMut.mutateAsync(id);
      setConfirmId(null);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : t("account.apiKeys.revokeFailed"));
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-2">
        <div>
          <h2 className="text-[13px] font-medium">{t("account.apiKeys.title")}</h2>
          <p className="text-[11px] text-text-dim mt-0.5">
            {t("account.apiKeys.description")}
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={signedOut}
          onClick={() => setCreateOpen(true)}
        >
          {t("account.apiKeys.create")}
        </Button>
      </div>

      {revokeError && <p className="text-[11px] text-down mb-2">{revokeError}</p>}

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
                    {c ? t(c) : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {signedOut && (
                <tr>
                  <td
                    colSpan={COL_KEYS.length}
                    className="px-3 py-12 text-center text-[11px] text-text-muted"
                  >
                    <Link href="/login" className="text-accent hover:underline">
                      {t("auth.login.submit")}
                    </Link>{" "}
                    {t("account.apiKeys.loginToManage")}
                  </td>
                </tr>
              )}
              {!signedOut && loading && (
                <tr>
                  <td
                    colSpan={COL_KEYS.length}
                    className="px-3 py-12 text-center text-[11px] text-text-muted"
                  >
                    {t("common.loading")}
                  </td>
                </tr>
              )}
              {!signedOut && !loading && error && (
                <tr>
                  <td
                    colSpan={COL_KEYS.length}
                    className="px-3 py-12 text-center text-[11px] text-down"
                  >
                    {error instanceof Error ? error.message : t("account.apiKeys.loadFailed")}
                  </td>
                </tr>
              )}
              {!signedOut && !loading && !error && (keys?.length ?? 0) === 0 && (
                <tr>
                  <td
                    colSpan={COL_KEYS.length}
                    className="px-3 py-12 text-center text-[11px] text-text-muted"
                  >
                    {t("account.apiKeys.empty")}
                  </td>
                </tr>
              )}
              {!signedOut &&
                !loading &&
                !error &&
                keys?.map((k) => (
                  <KeyRow
                    key={k.id}
                    k={k}
                    confirming={confirmId === k.id}
                    revoking={revokeMut.isPending && confirmId === k.id}
                    onAskRevoke={() => {
                      setRevokeError(null);
                      setConfirmId(k.id);
                    }}
                    onCancelRevoke={() => setConfirmId(null)}
                    onConfirmRevoke={() => confirmRevoke(k.id)}
                  />
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-text-muted mt-2">
        {t("account.apiKeys.docsPre")}{" "}
        <Link href="/api-docs" className="text-accent hover:underline">
          {t("account.apiKeys.docsLink")}
        </Link>{" "}
        {t("account.apiKeys.docsSuf")}
      </p>

      {createOpen && (
        <CreateApiKeyDialog
          onClose={() => setCreateOpen(false)}
          onIssued={(key) => {
            setCreateOpen(false);
            setIssued(key);
          }}
        />
      )}
      {issued && (
        <ApiKeySecretDialog issued={issued} onClose={() => setIssued(null)} />
      )}
    </div>
  );
}
