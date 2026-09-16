export type PriceTone = "up" | "down" | "dim";

export function priceTone(changePct: string | null | undefined): PriceTone {
  if (changePct === null || changePct === undefined) return "dim";
  const n = Number(changePct);
  if (!Number.isFinite(n) || n === 0) return "dim";
  return n > 0 ? "up" : "down";
}

export function formatPct(value: string | null, opts?: { signed?: boolean }): string {
  if (value === null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n).toFixed(2);
  const sign = opts?.signed ? (n > 0 ? "+" : n < 0 ? "-" : "") : n < 0 ? "-" : "";
  return `${sign}${abs}%`;
}

export function formatPrice(value: string | null): string {
  return value ?? "—";
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Thousands-grouped number for display (volumes, balances, fees). Display only — not for backend amounts. */
export function formatNum(value: string | number, maxFrac = 8): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFrac }).format(n);
}

/** Thousands-grouped integer (counts). */
export function formatInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** YYYY-MM-DD HH:mm from epoch ms. */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
