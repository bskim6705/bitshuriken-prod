import type { ReactNode } from "react";

/** Form/action error — announced assertively to screen readers (role=alert). */
export function InlineError({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p id={id} role="alert" aria-live="assertive" className={`text-[12px] text-down ${className ?? ""}`}>
      {children}
    </p>
  );
}
