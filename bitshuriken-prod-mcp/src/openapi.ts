// Read-only OpenAPI loading + query helpers for the Bitshuriken (prod) docs MCP.
// Each backend app serves a self-contained OpenAPI 3.1 document at /docs-json.

export interface Product {
  slug: string;
  title: string;
  baseUrl: string;
}

const env = (key: string, fallback: string): string =>
  process.env[key]?.trim() || fallback;

export const PRODUCTS: Product[] = [
  { slug: "spot", title: "Spot", baseUrl: env("BITSHURIKEN_PROD_SPOT_URL", "http://localhost:5101") },
  { slug: "futures", title: "Futures", baseUrl: env("BITSHURIKEN_PROD_FUTURES_URL", "http://localhost:5102") },
  { slug: "portal", title: "Portal", baseUrl: env("BITSHURIKEN_PROD_PORTAL_URL", "http://localhost:5103") },
];

export const PRODUCT_SLUGS = PRODUCTS.map((p) => p.slug) as [string, ...string[]];

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const cache = new Map<string, Json>();

/** Fetch (and cache) a product's OpenAPI document. Throws a readable error if the app is down. */
export async function loadSpec(slug: string): Promise<Json> {
  const cached = cache.get(slug);
  if (cached) return cached;
  const product = PRODUCTS.find((p) => p.slug === slug);
  if (!product) {
    throw new Error(`Unknown product "${slug}". Valid: ${PRODUCTS.map((p) => p.slug).join(", ")}`);
  }
  let res: Response;
  try {
    res = await fetch(`${product.baseUrl}/docs-json`);
  } catch (e) {
    throw new Error(
      `Cannot reach ${slug} at ${product.baseUrl}/docs-json — is the stack running? (./scripts/exchange.sh start) (${(e as Error).message})`,
    );
  }
  if (!res.ok) throw new Error(`${slug} returned HTTP ${res.status} for /docs-json`);
  const doc = (await res.json()) as Json;
  cache.set(slug, doc);
  return doc;
}

/** Drop cached specs so the next call refetches. */
export function clearCache(): void {
  cache.clear();
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

export interface EndpointRef {
  product: string;
  method: string;
  path: string;
  summary: string;
  tag: string;
}

export function endpointsOf(slug: string, doc: Json): EndpointRef[] {
  const out: EndpointRef[] = [];
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(methods as Json)) {
      if (!op || typeof op !== "object" || Array.isArray(op)) continue;
      if (!HTTP_METHODS.includes(method)) continue;
      out.push({
        product: slug,
        method: method.toUpperCase(),
        path,
        summary: (op as Json).summary ?? "",
        tag: (op as Json).tags?.[0] ?? "",
      });
    }
  }
  return out;
}

// ---- schema rendering (resolves $ref within the document) ----

function deref(doc: Json, node: Json, depth = 0): Json {
  if (node && typeof node === "object" && typeof node.$ref === "string" && depth < 8) {
    const parts = node.$ref.replace(/^#\//, "").split("/").map(decodeURIComponent);
    let target: Json = doc;
    for (const part of parts) target = target?.[part];
    return deref(doc, target, depth + 1);
  }
  return node;
}

function typeOf(doc: Json, schema: Json, depth = 0): string {
  schema = deref(doc, schema, depth);
  if (!schema || typeof schema !== "object") return "any";
  if (Array.isArray(schema.enum)) return `enum(${schema.enum.join(" | ")})`;
  if (schema.type === "array") return `${typeOf(doc, schema.items, depth + 1)}[]`;
  if (schema.type) return Array.isArray(schema.type) ? schema.type.join("|") : schema.type;
  if (schema.oneOf || schema.anyOf || schema.allOf) return "object";
  return schema.properties ? "object" : "any";
}

function propLines(doc: Json, schema: Json, depth = 0): string[] {
  schema = deref(doc, schema, depth);
  if (!schema || typeof schema !== "object" || !schema.properties) return [];
  const required = new Set<string>(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, prop]) => {
    const p = prop as Json;
    const desc = p?.description ? ` — ${String(p.description).split("\n")[0]}` : "";
    return `  - \`${name}\` ${typeOf(doc, p, depth + 1)}${required.has(name) ? " (required)" : ""}${desc}`;
  });
}

function jsonBlock(value: Json): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

function bodyOrExample(doc: Json, content: Json): string {
  const json = content?.["application/json"];
  if (!json) return "";
  if (json.example !== undefined) return jsonBlock(json.example);
  const schema = deref(doc, json.schema);
  if (schema?.example !== undefined) return jsonBlock(schema.example);
  const lines = propLines(doc, schema);
  return lines.length ? lines.join("\n") : "";
}

/** Full markdown detail for one operation, or null if not found. */
export function describeEndpoint(doc: Json, method: string, path: string): string | null {
  const op = doc.paths?.[path]?.[method.toLowerCase()];
  if (!op || typeof op !== "object") return null;

  const out: string[] = [`# ${method.toUpperCase()} ${path}`];
  if (op.summary) out.push(`**${op.summary}**`);
  if (op.tags?.length) out.push(`Tag: \`${op.tags[0]}\``);
  if (op.description) out.push(op.description);

  const params = (op.parameters ?? []).map((p: Json) => deref(doc, p));
  if (params.length) {
    out.push("## Parameters");
    out.push("| Name | In | Required | Type |");
    out.push("| --- | --- | --- | --- |");
    for (const p of params) {
      out.push(`| \`${p.name}\` | ${p.in} | ${p.required ? "yes" : "no"} | ${typeOf(doc, p.schema)} |`);
    }
  }

  if (op.requestBody) {
    const body = bodyOrExample(doc, deref(doc, op.requestBody).content);
    if (body) {
      out.push("## Request body");
      out.push(body);
    }
  }

  const responses = op.responses ?? {};
  if (Object.keys(responses).length) {
    out.push("## Responses");
    for (const [code, resp] of Object.entries(responses)) {
      const r = deref(doc, resp as Json);
      out.push(`### ${code} — ${r?.description ?? ""}`.trimEnd());
      const example = bodyOrExample(doc, r?.content);
      if (example) out.push(example);
    }
  }

  return out.join("\n\n");
}

// ---- guide (info.description) ----

export function guideMarkdown(doc: Json, section?: string): string {
  const md: string = doc.info?.description ?? "";
  if (!section) return md || "(no guide content)";
  // Extract the "## <section>" block up to the next "## " heading.
  const lines = md.split("\n");
  const wanted = section.toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.*)$/.exec(lines[i]);
    if (m && m[1].toLowerCase().includes(wanted)) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    const heads = lines.filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, ""));
    return `No section matching "${section}". Available sections: ${heads.join(", ") || "(none)"}`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

// ---- search ----

export interface SearchHit {
  kind: "endpoint" | "guide";
  product: string;
  ref: string;
  text: string;
}

export async function searchAll(query: string, productFilter?: string): Promise<SearchHit[]> {
  const q = query.toLowerCase();
  const slugs = productFilter ? [productFilter] : PRODUCTS.map((p) => p.slug);
  const hits: SearchHit[] = [];
  for (const slug of slugs) {
    let doc: Json;
    try {
      doc = await loadSpec(slug);
    } catch {
      continue; // skip unavailable products
    }
    for (const ep of endpointsOf(slug, doc)) {
      const hay = `${ep.method} ${ep.path} ${ep.summary} ${ep.tag}`.toLowerCase();
      if (hay.includes(q)) {
        hits.push({ kind: "endpoint", product: slug, ref: `${ep.method} ${ep.path}`, text: ep.summary });
      }
    }
    const md: string = doc.info?.description ?? "";
    let currentHeading = "Overview";
    for (const line of md.split("\n")) {
      const h = /^#{2,3}\s+(.*)$/.exec(line);
      if (h) currentHeading = h[1];
      if (line.toLowerCase().includes(q) && !/^#{1,6}\s/.test(line)) {
        hits.push({ kind: "guide", product: slug, ref: currentHeading, text: line.trim().slice(0, 160) });
      }
    }
  }
  return hits;
}
