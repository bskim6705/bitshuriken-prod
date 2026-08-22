"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { authApi } from "@/lib/api/auth";
import { useT } from "@/lib/i18n/provider";

export default function ForgotPasswordPage() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  // 계정 존재 여부를 노출하지 않도록 성공/실패와 무관하게 동일 메시지를 보인다.
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await authApi.forgotPassword(email);
    } catch {
      // 계정 열거 방지: 결과와 무관하게 동일하게 처리한다.
    } finally {
      setPending(false);
      setSent(true);
    }
  }

  return (
    <div>
      <h1 className="text-[20px] font-semibold mb-1">{t("auth.forgot.title")}</h1>
      <p className="text-[12px] text-text-dim mb-6">{t("auth.forgot.subtitle")}</p>
      {sent ? (
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-text">{t("auth.forgot.sent")}</p>
          <Link
            href="/login"
            className="text-[12px] text-accent hover:underline text-center"
          >
            {t("auth.forgot.backToLogin")}
          </Link>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <Field label={t("auth.email")}>
            <Input
              type="email"
              placeholder="you@domain.com"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={pending}
            />
          </Field>
          <Button variant="primary" size="lg" type="submit" disabled={pending}>
            {pending ? t("auth.forgot.sending") : t("auth.forgot.submit")}
          </Button>
          <Link
            href="/login"
            className="text-[12px] text-text-dim hover:text-text text-center"
          >
            {t("auth.forgot.backToLogin")}
          </Link>
        </form>
      )}
    </div>
  );
}
