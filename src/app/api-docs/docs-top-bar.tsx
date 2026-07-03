import Link from "next/link";
import { Wordmark } from "@/components/layout/wordmark";

export function DocsTopBar() {
  return (
    <header className="relative z-40 shrink-0 h-12 bg-bg border-b border-line">
      <div className="flex items-center h-full px-3 gap-3">
        <div className="flex items-center pr-3 border-r border-line h-6">
          <Wordmark />
        </div>
        <span className="text-[13px] font-medium">API Documentation</span>
        <span className="text-[10px] text-text-muted tnum tracking-wider ml-1">
          OPENAPI 3.1
        </span>
        <Link href="/" className="ml-auto text-[12px] text-text-dim hover:text-text">
          ← Back to site
        </Link>
      </div>
    </header>
  );
}
