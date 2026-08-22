"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { InlineError } from "@/components/ui/inline-error";
import { authApi } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";
import { useT } from "@/lib/i18n/provider";

const INVALID_OR_EXPIRED_TOKEN = 60016;

// useSearchParams는 Suspense 경계가 필요 (prerender 제약)
export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const t = useT();
  const search = useSearchParams();
  const token = search.get("token");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div>
        <h1 className="text-[20px] font-semibold mb-1">{t("auth.reset.title")}</h1>
        <p className="text-[13px] text-down mb-6">{t("auth.reset.invalidLink")}</p>
        <Link
          href="/forgot-password"
          className="text-[12px] text-accent hover:underline"
        >
          {t("auth.reset.requestNew")}
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div>
        <h1 className="text-[20px] font-semibold mb-1">{t("auth.reset.doneTitle")}</h1>
        <p className="text-[13px] text-text mb-6">{t("auth.reset.doneBody")}</p>
        <Link href="/login" className="text-[12px] text-accent hover:underline">
          {t("auth.reset.continueLogin")}
        </Link>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError(t("auth.reset.tooShort"));
      return;
    }
    if (password !== confirm) {
      setError(t("auth.reset.mismatch"));
      return;
    }
    setPending(true);
    try {
      await authApi.resetPassword(token as string, password);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === INVALID_OR_EXPIRED_TOKEN) {
        setError(t("auth.reset.invalidLink"));
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(t("auth.reset.generic"));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <h1 className="text-[20px] font-semibold mb-1">{t("auth.reset.title")}</h1>
      <p className="text-[12px] text-text-dim mb-6">{t("auth.reset.subtitle")}</p>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <Field label={t("auth.reset.newPassword")}>
          <PasswordInput
            placeholder={t("auth.signup.passwordPlaceholder")}
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
          />
        </Field>
        <Field label={t("auth.reset.confirmPassword")}>
          <PasswordInput
            placeholder={t("auth.reset.confirmPlaceholder")}
            autoComplete="new-password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={pending}
          />
        </Field>
        {error && <InlineError>{error}</InlineError>}
        <Button variant="primary" size="lg" type="submit" disabled={pending}>
          {pending ? t("auth.reset.updating") : t("auth.reset.submit")}
        </Button>
      </form>
    </div>
  );
}
