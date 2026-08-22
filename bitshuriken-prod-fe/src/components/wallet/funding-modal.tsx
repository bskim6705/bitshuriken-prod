"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, LabeledInput } from "@/components/ui/input";
import { ApiError } from "@/lib/api/client";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useBalances } from "@/lib/hooks/use-trading";
import { useExchangeInfo } from "@/lib/hooks/use-market";
import { useDeposit, useWithdraw } from "@/lib/hooks/use-funding";
import { useT } from "@/lib/i18n/provider";

export type FundingMode = "deposit" | "withdraw";

const TWO_FACTOR_REQUIRED = 60010;
const INVALID_TWO_FACTOR_CODE = 60011;
const EMAIL_NOT_VERIFIED = 60014;
const TOTP_INPUT_ID = "withdraw-totp-code";

const NUMERIC_RE = /^\d*\.?\d*$/;

function isPos(v: string): boolean {
  return v !== "" && NUMERIC_RE.test(v) && Number(v) > 0;
}

function decimalsOf(v: string): number {
  const i = v.indexOf(".");
  return i === -1 ? 0 : v.length - i - 1;
}

/** 제출 직전 trailing dot 제거 ("5." → "5"). */
function normDecimal(v: string): string {
  return v.endsWith(".") ? v.slice(0, -1) : v;
}

// 표시 문자열은 렌더에서 t()로 해석한다 (훅은 모듈 스코프 불가).
const LABEL_KEYS: Record<
  FundingMode,
  { title: string; cta: string; pending: string; failed: string }
> = {
  deposit: {
    title: "wallet.funding.depositTitle",
    cta: "wallet.funding.depositCta",
    pending: "wallet.funding.depositPending",
    failed: "wallet.funding.depositFailed",
  },
  withdraw: {
    title: "wallet.funding.withdrawTitle",
    cta: "wallet.funding.withdrawCta",
    pending: "wallet.funding.withdrawPending",
    failed: "wallet.funding.withdrawFailed",
  },
};

/** dev 입출금 모달 — 체인 없이 SPOT 지갑 즉시 가산/차감 */
export function FundingModal({ mode, onClose }: { mode: FundingMode; onClose: () => void }) {
  const t = useT();
  const labelKeys = LABEL_KEYS[mode];
  const balances = useBalances();
  const { data: exchangeInfo } = useExchangeInfo();
  const { data: user } = useCurrentUser();
  const depositMut = useDeposit();
  const withdrawMut = useWithdraw();
  const mut = mode === "deposit" ? depositMut : withdrawMut;

  // 출금만: 이메일 미인증이면 차단, 2FA 활성 시 코드 입력 요구
  const isWithdraw = mode === "withdraw";
  const emailUnverified = isWithdraw && user?.emailVerified === false;
  const needsTotp = isWithdraw && user?.twoFactorEnabled === true;

  const assets = useMemo(() => {
    const set = new Set<string>();
    for (const s of exchangeInfo?.symbols ?? []) {
      set.add(s.baseAsset);
      set.add(s.quoteAsset);
    }
    return [...set].sort();
  }, [exchangeInfo]);

  const [asset, setAsset] = useState("USDT");
  const [qty, setQty] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [showTotp, setShowTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = balances.data?.find((b) => b.asset === asset)?.free ?? null;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function handleQty(v: string) {
    if (!NUMERIC_RE.test(v)) return;
    setQty(v);
    setError(null);
  }

  function revealTotp(message: string) {
    setShowTotp(true);
    setError(message);
    // 입력란이 마운트된 뒤 포커스
    requestAnimationFrame(() => document.getElementById(TOTP_INPUT_ID)?.focus());
  }

  async function submit() {
    if (emailUnverified) return;
    if (!isPos(qty)) {
      setError(t("wallet.funding.invalidQty"));
      return;
    }
    if (decimalsOf(qty) > 8) {
      setError(t("wallet.funding.maxDecimals"));
      return;
    }
    setError(null);
    try {
      await mut.mutateAsync({
        assetSymbol: asset,
        qty: normDecimal(qty),
        ...(needsTotp && totpCode !== "" ? { totpCode } : {}),
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === EMAIL_NOT_VERIFIED) {
          setError(t("wallet.funding.emailNotVerified"));
          return;
        }
        if (err.code === TWO_FACTOR_REQUIRED) {
          revealTotp(t("wallet.funding.twoFactorRequired"));
          return;
        }
        if (err.code === INVALID_TWO_FACTOR_CODE) {
          revealTotp(t("wallet.funding.invalidTwoFactor"));
          return;
        }
      }
      setError(err instanceof Error ? err.message : t(labelKeys.failed));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t(labelKeys.title)}
        className="w-full max-w-[360px] bg-surface border border-line"
      >
        <header className="flex items-center justify-between px-4 h-10 border-b border-line">
          <h2 className="text-[13px] font-medium">{t(labelKeys.title)}</h2>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="w-7 h-7 grid place-items-center text-text-dim hover:text-text"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="p-4 flex flex-col gap-3">
          {emailUnverified && (
            <div className="bg-raised border border-line-strong px-3 py-2.5 text-[11px] flex flex-col gap-1">
              <span className="text-down">{t("wallet.funding.verifyEmailToWithdraw")}</span>
              <Link href="/account/security" className="text-accent hover:underline w-fit">
                {t("wallet.funding.goToSecurity")}
              </Link>
            </div>
          )}

          <div className="flex items-center h-9 bg-raised border border-line px-3 text-[12px] gap-2">
            <span className="text-text-dim w-10 shrink-0">{t("wallet.funding.asset")}</span>
            <select
              value={asset}
              onChange={(e) => {
                setAsset(e.target.value);
                setError(null);
              }}
              className="flex-1 bg-transparent focus:outline-none"
            >
              {(assets.length ? assets : [asset]).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <LabeledInput
              label={t("wallet.funding.qty")}
              suffix={asset}
              value={qty}
              onChange={(e) => handleQty(e.target.value)}
              placeholder="0"
              inputMode="decimal"
            />
            {mode === "withdraw" && (
              <p className="flex items-center justify-between text-[11px]">
                <span className="text-text-dim">
                  {t("wallet.funding.available")}{" "}
                  <span className="text-text tnum">{available ?? "—"}</span>{" "}
                  <span className="text-text-muted">{asset}</span>
                </span>
                <button
                  type="button"
                  onClick={() => available !== null && handleQty(available)}
                  disabled={available === null}
                  className="text-accent hover:underline disabled:text-text-muted disabled:no-underline"
                >
                  {t("wallet.funding.max")}
                </button>
              </p>
            )}
          </div>

          {isWithdraw && (needsTotp || showTotp) && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-text-dim">{t("wallet.funding.twoFactorLabel")}</span>
              <Input
                id={TOTP_INPUT_ID}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                maxLength={6}
                pattern="[0-9]{6}"
                value={totpCode}
                onChange={(e) => {
                  setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                  setError(null);
                }}
                disabled={mut.isPending || emailUnverified}
              />
              <span className="text-[11px] text-text-muted">
                {t("wallet.funding.twoFactorHint")}
              </span>
            </label>
          )}

          {error && <p className="text-[11px] text-down">{error}</p>}

          <Button
            variant="primary"
            onClick={submit}
            disabled={mut.isPending || emailUnverified}
            className="w-full"
          >
            {mut.isPending ? t(labelKeys.pending) : t(labelKeys.cta)}
          </Button>
        </div>
      </div>
    </div>
  );
}
