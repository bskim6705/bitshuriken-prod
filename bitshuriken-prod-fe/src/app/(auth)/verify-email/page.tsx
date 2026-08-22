"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { authApi } from "@/lib/api/auth";
import { useT } from "@/lib/i18n/provider";

type Status = "loading" | "success" | "error";

// useSearchParams는 Suspense 경계가 필요 (prerender 제약)
export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}

function VerifyEmail() {
  const t = useT();
  const search = useSearchParams();
  const token = search.get("token");

  const [status, setStatus] = useState<Status>(token ? "loading" : "error");
  // StrictMode/리렌더에서 검증을 한 번만 호출하기 위한 가드.
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    authApi
      .verifyEmail(token)
      .then(() => setStatus("success"))
      .catch(() => setStatus("error"));
  }, [token]);

  return (
    <div>
      <h1 className="text-[20px] font-semibold mb-1">{t("auth.verify.title")}</h1>
      {status === "loading" && (
        <p className="text-[13px] text-text-dim mt-4">{t("auth.verify.loading")}</p>
      )}
      {status === "success" && (
        <div className="mt-4 flex flex-col gap-4">
          <p className="text-[13px] text-up">{t("auth.verify.success")} ✓</p>
          <Link href="/login" className="text-[12px] text-accent hover:underline">
            {t("auth.verify.continueLogin")}
          </Link>
        </div>
      )}
      {status === "error" && (
        <div className="mt-4 flex flex-col gap-4">
          <p className="text-[13px] text-down">{t("auth.verify.error")}</p>
          <Link href="/login" className="text-[12px] text-accent hover:underline">
            {t("auth.verify.backToLogin")}
          </Link>
        </div>
      )}
    </div>
  );
}
