#!/usr/bin/env node
// Bitshuriken (prod) docs MCP — read-only access to the spot/futures/portal
// OpenAPI references (endpoints, schemas, and the auth/rate-limit/WS/error
// guides). Lets an AI assistant answer questions about the API.
// No auth, no trading — query/inspection only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  PRODUCTS,
  PRODUCT_SLUGS,
  loadSpec,
  clearCache,
  endpointsOf,
  describeEndpoint,
  guideMarkdown,
  searchAll,
} from "./openapi.js";

const server = new McpServer({ name: "bitshuriken-prod-docs", version: "0.1.0" });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

const productArg = z.enum(PRODUCT_SLUGS);

server.tool(
  "list_products",
  "List the Bitshuriken (prod) API products (spot, futures, portal) with base URLs and endpoint counts.",
  {},
  async () => {
    const lines: string[] = [];
    for (const p of PRODUCTS) {
      try {
        const doc = await loadSpec(p.slug);
        lines.push(
          `- **${p.slug}** — ${doc.info?.title ?? p.title} (v${doc.info?.version ?? "?"}), ` +
            `base ${p.baseUrl}, ${endpointsOf(p.slug, doc).length} endpoints`,
        );
      } catch (e) {
        lines.push(`- **${p.slug}** — ${p.baseUrl} (unavailable: ${(e as Error).message})`);
      }
    }
    return text(lines.join("\n"));
  },
);

server.tool(
  "list_endpoints",
  "List REST endpoints as 'METHOD /path — summary'. Optionally filter by product and/or a keyword (matches path, summary, or tag).",
  { product: productArg.optional(), query: z.string().optional() },
  async ({ product, query }) => {
    const slugs = product ? [product] : PRODUCTS.map((p) => p.slug);
    const q = query?.toLowerCase();
    const out: string[] = [];
    for (const slug of slugs) {
      let doc;
      try {
        doc = await loadSpec(slug);
      } catch (e) {
        out.push(`## ${slug}\n(unavailable: ${(e as Error).message})`);
        continue;
      }
      let eps = endpointsOf(slug, doc);
      if (q) eps = eps.filter((e) => `${e.method} ${e.path} ${e.summary} ${e.tag}`.toLowerCase().includes(q));
      out.push(`## ${slug} (${eps.length})`);
      for (const e of eps) out.push(`- \`${e.method} ${e.path}\` — ${e.summary}`);
    }
    const body = out.join("\n");
    return text(body.trim() ? body : "No endpoints matched.");
  },
);

server.tool(
  "get_endpoint",
  "Get full detail (parameters, request body, responses with examples) for one endpoint.",
  { product: productArg, method: z.string().describe("GET/POST/PUT/PATCH/DELETE"), path: z.string().describe("e.g. /spot/trading/orders") },
  async ({ product, method, path }) => {
    let doc;
    try {
      doc = await loadSpec(product);
    } catch (e) {
      return fail((e as Error).message);
    }
    const detail = describeEndpoint(doc, method, path);
    if (!detail) {
      return fail(
        `No ${method.toUpperCase()} ${path} in ${product}. Use list_endpoints to see valid paths.`,
      );
    }
    return text(detail);
  },
);

server.tool(
  "get_guide",
  "Get a product's narrative guide (markdown): Overview, Authentication, Rate limits, Error codes, WebSocket market streams, User data stream, Subaccounts (portal). Pass a section name to get just that part.",
  { product: productArg, section: z.string().optional().describe('e.g. "authentication", "rate limits", "error codes", "websocket", "subaccounts"') },
  async ({ product, section }) => {
    try {
      const doc = await loadSpec(product);
      return text(guideMarkdown(doc, section));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.tool(
  "search",
  "Search endpoints and guides by keyword across products (or one product).",
  { query: z.string(), product: productArg.optional() },
  async ({ query, product }) => {
    const hits = await searchAll(query, product);
    if (!hits.length) return text(`No matches for "${query}".`);
    const eps = hits.filter((h) => h.kind === "endpoint");
    const guides = hits.filter((h) => h.kind === "guide");
    const out: string[] = [];
    if (eps.length) {
      out.push("## Endpoints");
      for (const h of eps) out.push(`- [${h.product}] \`${h.ref}\` — ${h.text}`);
    }
    if (guides.length) {
      out.push("## Guides");
      for (const h of guides) out.push(`- [${h.product} · ${h.ref}] ${h.text}`);
    }
    return text(out.join("\n"));
  },
);

server.tool(
  "refresh",
  "Clear the cached OpenAPI specs so the next query refetches from the backends.",
  {},
  async () => {
    clearCache();
    return text("Cache cleared. Specs will be refetched on the next query.");
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
  // stdio transport owns stdout; log only to stderr.
  console.error("bitshuriken-prod-docs MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
