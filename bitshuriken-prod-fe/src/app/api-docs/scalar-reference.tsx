"use client";

import { useEffect, useRef } from "react";
import { createApiReference } from "@scalar/api-reference";
import "@scalar/api-reference/style.css";

type ScalarInstance = ReturnType<typeof createApiReference>;

// Each backend serves a self-contained OpenAPI document at /docs-json — the
// per-product overview, auth, WebSocket/user-data guides, and error catalog all
// live in info.description (see BE libs/shared/src/docs). Scalar fetches by URL;
// the source dropdown switches Spot / Futures / Portal.
const sources = [
  { slug: "spot", title: "Spot", url: process.env.NEXT_PUBLIC_API_URL, default: true },
  { slug: "futures", title: "Futures", url: process.env.NEXT_PUBLIC_FUTURES_API_URL },
  { slug: "portal", title: "Portal", url: process.env.NEXT_PUBLIC_PORTAL_API_URL },
]
  .filter((s): s is { slug: string; title: string; url: string; default?: boolean } =>
    Boolean(s.url),
  )
  .map((s) => ({
    slug: s.slug,
    title: s.title,
    url: `${s.url}/docs-json`,
    default: s.default,
    // No in-docs "Ask AI" chat — we ship an MCP server instead.
    agent: { disabled: true },
  }));

// Align Scalar's deepSpace theme to the app palette (flat dark + single yellow
// accent) and trim leftover chrome. Injected into Scalar's config layer, which
// wins over its theme layer. HTTP method colors are left as Scalar's defaults.
const SCALAR_CUSTOM_CSS = `
.dark-mode {
  --scalar-background-1: #0b0e11;
  --scalar-background-2: #181a20;
  --scalar-background-3: #1e2329;
  --scalar-sidebar-background-1: #0b0e11;
  --scalar-border-color: #2b3139;
  --scalar-color-1: #eaecef;
  --scalar-color-2: #848e9c;
  --scalar-color-3: #5e6673;
  --scalar-color-accent: #fcd535;
  --scalar-background-accent: rgba(252, 213, 53, 0.1);
}
/* Hide the Ask AI button in the sidebar search row (no AI backend configured) */
.t-doc__sidebar button.whitespace-nowrap.px-2 {
  display: none;
}
/* deepSpace theme's decorative starfield/flare backdrop — drop it for a flat bg */
.section-flare,
.section-flare-item {
  display: none !important;
}
/* Binance-style single column: stop pinning request left / example right.
   The per-operation split is a flex row of .section-column; stack it. Tag
   headers (title | blurb) are a 2-col grid; collapse to one column too. */
.section-columns {
  flex-direction: column !important;
}
.section-column {
  max-width: 100% !important;
}
.section-header-wrapper {
  grid-template-columns: minmax(0, 1fr) !important;
}
/* Clicking a tag should just toggle its sidebar accordion. Hide the redundant
   "Operations" index card Scalar renders in the tag's content section — the
   sidebar already lists those operations; clicking one still opens its detail. */
.endpoints-card {
  display: none !important;
}
`;

// Sidebar group order by importance (Binance parity): market -> trading ->
// account -> user data stream (spot/futures); for portal: api-keys -> transfers
// -> history -> net-worth -> leaderboard. More-specific keys precede "account".
const TAG_PRIORITY = [
  "market",
  "trading",
  "api-keys",
  "subaccount",
  "transfers",
  "history",
  "net-worth",
  "account",
  "user-data-stream",
  "leaderboard",
];
function tagRank(name: string): number {
  const n = name.toLowerCase();
  const i = TAG_PRIORITY.findIndex((k) => n.includes(k));
  return i === -1 ? TAG_PRIORITY.length : i;
}
function sortTagsByImportance(a: unknown, b: unknown): number {
  const name = (t: unknown) =>
    typeof t === "string" ? t : ((t as { name?: string })?.name ?? "");
  const an = name(a);
  const bn = name(b);
  return tagRank(an) - tagRank(bn) || an.localeCompare(bn);
}

/**
 * Mounts the Scalar API reference. Browser-only (Scalar is a Vue app): mount in
 * useEffect, destroy on unmount.
 */
export function ScalarReference() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const instance: ScalarInstance = createApiReference(el, {
      sources,
      layout: "modern",
      theme: "deepSpace",
      darkMode: true,
      forceDarkModeState: "dark",
      hideDarkModeToggle: true,
      hideClientButton: true,
      hideModels: false,
      // Sidebar tag groups act as accordions: collapsed by default, click a tag
      // to expand/collapse its endpoint sub-list. Only the first group opens on
      // load (defaultOpenFirstTag defaults true). Content stays a single-column
      // long scroll (modern layout); this only changes the sidebar.
      defaultOpenAllTags: false,
      expandAllResponses: true,
      tagsSorter: sortTagsByImportance,
      // Default is "localhost", which surfaces a Developer Tools button in dev.
      showDeveloperTools: "never",
      customCss: SCALAR_CUSTOM_CSS,
    });

    return () => instance.destroy();
  }, []);

  return <div ref={containerRef} className="scalar-host" />;
}
