"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { InlineError } from "@/components/ui/inline-error";
import { useSignup } from "@/lib/hooks/use-auth";
import { useT } from "@/lib/i18n/provider";

export default function SignupPage() {
  const t = useT();
  const router = useRouter();
  const signup = useSignup();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agree, setAgree] = useState(false);

  return (
    <div>
      <h1 className="text-[20px] font-semibold mb-1">{t("auth.signup.title")}</h1>
      <p className="text-[12px] text-text-dim mb-6">{t("auth.signup.subtitle")}</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!agree) return;
          signup.mutate(
            { email, password },
            { onSuccess: () => router.push("/markets") },
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
            disabled={signup.isPending}
          />
        </Field>
        <Field label={t("auth.password")}>
          <PasswordInput
            placeholder={t("auth.signup.passwordPlaceholder")}
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={signup.isPending}
          />
        </Field>
        <label className="flex items-start gap-2 text-[11px] text-text-dim">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
            disabled={signup.isPending}
          />
          <span>
            {t("auth.signup.agreePre")}{" "}
            <Link href="/#terms" className="text-accent hover:underline">
              {t("auth.signup.terms")}
            </Link>
            {t("auth.signup.agreeSuf")}
          </span>
        </label>
        {signup.isError && <InlineError>{signup.error.message}</InlineError>}
        <Button
          variant="primary"
          size="lg"
          type="submit"
          disabled={signup.isPending || !agree}
        >
          {signup.isPending ? t("auth.signup.creating") : t("auth.signup.submit")}
        </Button>
      </form>
      <p className="mt-6 text-[12px] text-text-dim text-center">
        {t("auth.signup.haveAccount")}{" "}
        <Link href="/login" className="text-accent hover:underline">
          {t("auth.signup.login")}
        </Link>
      </p>
    </div>
  );
}
