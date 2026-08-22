import type { Metadata } from "next";
import { DocsTopBar } from "./docs-top-bar";

export const metadata: Metadata = {
  title: "API Documentation · Bitshuriken",
  description: "REST, WebSocket, and authentication reference for the Bitshuriken exchange.",
};

// Full-viewport docs shell. The top bar is fixed; the content region below fills
// the rest. The REST reference (Scalar) manages its own internal scroll, while
// the Guides route scrolls inside the same region.
export default function ApiDocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-dvh flex flex-col overflow-hidden bg-bg text-text">
      <DocsTopBar />
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
