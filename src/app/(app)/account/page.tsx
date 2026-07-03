"use client";

import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useCommission } from "@/lib/hooks/use-trading";
import { DisplayNameEditor } from "@/components/account/display-name-editor";
import { useT } from "@/lib/i18n/provider";

function formatJoined(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// bps(만분율) → percent string, e.g. 10 → "0.10%"
function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function Rows({ rows }: { rows: { label: string; value: string; muted?: boolean }[] }) {
  return (
    <div className="bg-surface border border-line">
      {rows.map((r, i) => (
        <div
          key={r.label}
          className={`flex items-center justify-between px-3 py-2.5 ${
            i < rows.length - 1 ? "border-b border-line" : ""
          }`}
        >
          <span className="text-[12px] text-text-dim">{r.label}</span>
          <span className={`text-[12px] tnum ${r.muted ? "text-text-muted" : "text-text"}`}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function AccountProfilePage() {
  const t = useT();
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const { data: commission, isLoading: commissionLoading } = useCommission();

  const signedOut = !authLoading && user == null;

  if (authLoading) {
    return (
      <div>
        <h2 className="text-[13px] font-medium mb-2">{t("account.profile.title")}</h2>
        <div className="bg-surface border border-line px-3 py-6 text-center text-[12px] text-text-muted">
          {t("common.loading")}
        </div>
      </div>
    );
  }

  if (signedOut) {
    return (
      <div>
        <h2 className="text-[13px] font-medium mb-2">{t("account.profile.title")}</h2>
        <div className="bg-surface border border-line px-3 py-6 text-center text-[12px] text-text-muted">
          {t("account.profile.loginToView")}
        </div>
      </div>
    );
  }

  const notAvailable = t("account.profile.notAvailable");
  const identityRows: { label: string; value: string; muted?: boolean }[] = [
    { label: t("account.profile.userId"), value: user?.id ?? "—" },
    { label: t("account.profile.email"), value: user?.email ?? "—" },
    { label: t("account.profile.phone"), value: notAvailable, muted: true },
    { label: t("account.profile.joined"), value: user ? formatJoined(user.createdAt) : "—" },
    { label: t("account.profile.kycLevel"), value: notAvailable, muted: true },
    { label: t("account.profile.vipTier"), value: notAvailable, muted: true },
  ];

  const feeValue = commissionLoading
    ? t("common.loading")
    : commission
    ? t("account.profile.makerTaker", {
        maker: bpsToPercent(commission.makerBps),
        taker: bpsToPercent(commission.takerBps),
      })
    : notAvailable;

  const feeMuted = !commission;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[13px] font-medium mb-2">{t("account.profile.title")}</h2>
        <Rows rows={identityRows} />
      </div>

      <DisplayNameEditor />

      <div>
        <h2 className="text-[13px] font-medium mb-2">{t("account.profile.feeTier")}</h2>
        <Rows rows={[{ label: t("account.profile.spotTradingFee"), value: feeValue, muted: feeMuted }]} />
      </div>
    </div>
  );
}
