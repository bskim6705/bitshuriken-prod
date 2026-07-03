"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { InlineError } from "@/components/ui/inline-error";
import { ApiError } from "@/lib/api/client";
import { useLogin } from "@/lib/hooks/use-auth";
import { useT } from "@/lib/i18n/provider";

const TWO_FACTOR_REQUIRED = 60010;
const INVALID_TWO_FACTOR_CODE = 60011;

// useSearchParams는 Suspense 경계가 필요 (prerender 제약)
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const t = useT();
  const router = useRouter();
  const search = useSearchParams();
  const login = useLogin();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [twoFactor, setTwoFactor] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <h1 className="text-[20px] font-semibold mb-1">{t("auth.login.title")}</h1>
      <p className="text-[12px] text-text-dim mb-6">{t("auth.login.subtitle")}</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          login.mutate(
            { email, password, totpCode: twoFactor ? totpCode : undefined },
            {
              onSuccess: () => {
                const next = search.get("next") ?? "/markets";
                router.push(next);
              },
              onError: (err) => {
                if (err instanceof ApiError && err.code === TWO_FACTOR_REQUIRED) {
                  setTwoFactor(true);
                  setError(null);
                  return;
                }
                if (err instanceof ApiError && err.code === INVALID_TWO_FACTOR_CODE) {
                  setError(t("auth.login.invalidCode"));
                  return;
                }
                setError(err.message);
              },
            },
          );
        }}
      >
        <Field label={t("auth.email")}>
          <Input
            type="email"
            placeholder="you@domain.com"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={login.isPending || twoFactor}
          />
        </Field>
        <Field
          label={t("auth.password")}
          right={
            <Link
              href="/forgot-password"
              className="text-[11px] text-accent hover:underline"
            >
              {t("auth.login.forgot")}
            </Link>
          }
        >
          <PasswordInput
            placeholder="••••••••"
            autoComplete="current-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={login.isPending || twoFactor}
          />
        </Field>
        {twoFactor && (
          <Field label={t("auth.login.twoFactorLabel")}>
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              required
              maxLength={6}
              pattern="[0-9]{6}"
              autoFocus
              value={totpCode}
              onChange={(e) =>
                setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              disabled={login.isPending}
            />
            <span className="text-[11px] text-text-muted">
              {t("auth.login.twoFactorHint")}
            </span>
          </Field>
        )}
        {error && <InlineError>{error}</InlineError>}
        <Button variant="primary" size="lg" type="submit" disabled={login.isPending}>
          {login.isPending
            ? t("auth.login.signingIn")
            : twoFactor
              ? t("auth.login.verify")
              : t("auth.login.submit")}
        </Button>
      </form>
      <p className="mt-6 text-[12px] text-text-dim text-center">
        {t("auth.login.newToBrand")}{" "}
        <Link href="/signup" className="text-accent hover:underline">
          {t("auth.login.createAccount")}
        </Link>
      </p>
    </div>
  );
}
