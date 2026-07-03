import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function Panel({
  title,
  right,
  children,
  className,
}: {
  title?: string;
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("bg-surface flex flex-col h-full min-h-0", className)}>
      {(title || right) && (
        <header className="flex items-center justify-between px-3 h-9 border-b border-line shrink-0">
          {title && <h2 className="text-[13px] font-medium text-text">{title}</h2>}
          {right}
        </header>
      )}
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}

export function PanelEmpty({ hint }: { hint: string }) {
  return (
    <div className="h-full min-h-[120px] grid place-items-center text-center p-6">
      <p className="text-[12px] text-text-muted max-w-[36ch]">{hint}</p>
    </div>
  );
}
