"use client";

import { useEffect, useState } from "react";
import { useCurrentUser, useUpdateProfile } from "@/lib/hooks/use-auth";
import { ApiError } from "@/lib/api/client";
import { useT } from "@/lib/i18n/provider";

const MAX = 24;
const VALID = /^[\w .-]+$/;

// BE maskEmail와 동일 규칙 — 미설정 시 리더보드 표시 미리보기.
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

export function DisplayNameEditor() {
  const t = useT();
  const { data: user } = useCurrentUser();
  const update = useUpdateProfile();
  const [value, setValue] = useState("");

  const current = user?.displayName ?? "";
  useEffect(() => {
    setValue(current);
  }, [current]);

  if (!user) return null;

  const trimmed = value.trim();
  const tooLong = trimmed.length > MAX;
  const invalidChars = trimmed.length > 0 && !VALID.test(trimmed);
  const dirty = trimmed !== current;
  const canSave = dirty && !tooLong && !invalidChars && !update.isPending;

  const preview = trimmed.length > 0 ? trimmed : maskEmail(user.email);
  const errorMsg = tooLong
    ? t("account.displayName.tooLong", { max: MAX })
    : invalidChars
    ? t("account.displayName.invalidChars")
    : update.error instanceof ApiError
    ? update.error.message
    : null;

  function onSave() {
    if (!canSave) return;
    update.mutate(trimmed.length === 0 ? null : trimmed);
  }

  return (
    <div>
      <h2 className="text-[13px] font-medium mb-2">{t("account.displayName.title")}</h2>
      <div className="bg-surface border border-line p-3 flex flex-col gap-2">
        <p className="text-[11px] text-text-dim">
          {t("account.displayName.description")}
        </p>
        <div className="flex items-center gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSave();
            }}
            maxLength={MAX}
            placeholder={maskEmail(user.email)}
            aria-label={t("account.displayName.aria")}
            className="h-9 flex-1 bg-raised border border-line px-3 text-[13px] text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
          <button
            onClick={onSave}
            disabled={!canSave}
            className="h-9 px-4 text-[12px] font-medium bg-accent text-bg hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {update.isPending ? "…" : t("common.save")}
          </button>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className={errorMsg ? "text-down" : "text-text-dim"}>
            {errorMsg ?? (
              <>
                {t("account.displayName.appearsAs")} <span className="text-text">{preview}</span>
              </>
            )}
          </span>
          {update.isSuccess && !dirty && !errorMsg && (
            <span className="text-up">{t("account.displayName.saved")}</span>
          )}
        </div>
      </div>
    </div>
  );
}
