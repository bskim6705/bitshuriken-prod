import { cn } from "@/lib/utils";
import type { InputHTMLAttributes } from "react";

export function Input({
  className,
  type,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  // email fields get the right mobile keyboard + no autocapitalize/spellcheck (callers can override)
  const emailHints =
    type === "email" ? { inputMode: "email" as const, autoCapitalize: "none", spellCheck: false } : {};
  return (
    <input
      type={type}
      {...emailHints}
      {...props}
      className={cn(
        "h-9 w-full bg-raised border border-line px-3 text-[13px] text-text tnum",
        "focus:outline-none focus:border-accent",
        "placeholder:text-text-muted",
        className
      )}
    />
  );
}

export function Field({
  label,
  children,
  right,
}: {
  label: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-text-dim">{label}</span>
        {right}
      </div>
      {children}
    </label>
  );
}

export function LabeledInput({
  label,
  suffix,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; suffix?: string }) {
  return (
    <div className="relative flex items-center h-9 bg-raised border border-line focus-within:border-accent">
      <span className="pl-3 pr-2 text-[11px] text-text-dim shrink-0 border-r border-line h-full flex items-center">
        {label}
      </span>
      <input
        className="flex-1 bg-transparent px-3 text-[13px] text-text tnum placeholder:text-text-muted focus:outline-none"
        {...props}
      />
      {suffix && (
        <span className="pr-3 text-[11px] text-text-dim">{suffix}</span>
      )}
    </div>
  );
}
