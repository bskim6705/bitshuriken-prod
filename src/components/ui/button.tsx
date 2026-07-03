import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "outline" | "buy" | "sell";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-bg hover:bg-accent-hover font-medium",
  ghost: "text-text-dim hover:text-text hover:bg-raised",
  outline: "border border-line-strong text-text hover:bg-raised",
  buy: "bg-up text-white hover:bg-up/90 font-medium",
  sell: "bg-down text-white hover:bg-down/90 font-medium",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-3 text-[12px]",
  md: "h-9 px-4 text-[13px]",
  lg: "h-11 px-5 text-[14px]",
};

export function Button({
  variant = "outline",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...props}
    />
  );
}
