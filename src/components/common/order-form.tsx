"use client";

import Link from "next/link";
import type { TimeInForce } from "@/lib/types/trading";
import { useT } from "@/lib/i18n/provider";

/** 폼 상단 주문 타입 탭 스트립. */
export function FormTabs<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: { key: T; label: string }[];
  active: T;
  onSelect: (key: T) => void;
}) {
  return (
    <div className="flex items-center border-b border-line h-8 shrink-0 overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onSelect(t.key)}
          className={`px-2.5 h-full text-[12px] whitespace-nowrap shrink-0 border-b-2 -mb-px ${
            t.key === active
              ? "text-text font-medium border-accent"
              : "text-text-dim hover:text-text border-transparent"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function TifSelector({
  options,
  value,
  onChange,
}: {
  options: TimeInForce[];
  value: TimeInForce;
  onChange: (t: TimeInForce) => void;
}) {
  const tr = useT();
  return (
    <div className="pt-1 flex items-center justify-between text-[11px]">
      <span className="text-text-dim">{tr("widgets.orderForm.tif")}</span>
      <div className="flex gap-1">
        {options.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            className={`px-2 h-6 border ${
              t === value
                ? "border-line-strong text-text"
                : "border-line text-text-dim hover:text-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "label — value unit" 정보 행 (Avail./Cost). */
export function InfoRow({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-text-dim">{label}</span>
      <span className="tnum">
        <span className="text-text">{value}</span>{" "}
        <span className="text-text-muted">{unit}</span>
      </span>
    </div>
  );
}

export function CheckboxRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-text-dim cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function StatusMessages({ error, flash }: { error: string | null; flash: boolean }) {
  const tr = useT();
  return (
    <>
      {error && <p className="text-[11px] text-down">{error}</p>}
      {flash && <p className="text-[11px] text-up">{tr("widgets.orderForm.placed")}</p>}
    </>
  );
}

/** 비로그인 상태 CTA — Log In / Sign Up. */
export function GuestCta() {
  const tr = useT();
  return (
    <div className="grid grid-cols-2 gap-2 mt-1">
      <Link
        href="/login"
        className="h-9 inline-flex items-center justify-center text-[13px] border border-line-strong text-text hover:bg-raised"
      >
        {tr("widgets.orderForm.logIn")}
      </Link>
      <Link
        href="/signup"
        className="h-9 inline-flex items-center justify-center text-[13px] bg-accent text-bg hover:bg-accent-hover font-medium"
      >
        {tr("widgets.orderForm.signUp")}
      </Link>
    </div>
  );
}
