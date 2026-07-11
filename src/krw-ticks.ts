// Upbit KRW-market tiered price units, reproduced as-is (ADR-066). Upbit's tick size is a
// step function of price, not a single value — this is the same table the exchange enforces
// on KRW-quote tickers (mirror of BE libs/shared/src/constants/krw-tick.ts; keep in sync).
//
// A mirrored Upbit price is already tier-aligned, so snapping to tickForPrice() is a no-op for
// genuine prints and only matters for interpolated levels.

interface Tier {
  min: number; // price >= min uses this tick (descending scan)
  tick: number;
}

// Descending by min. Source: Upbit KRW market order-price-unit table.
const KRW_TIERS: Tier[] = [
  { min: 2_000_000, tick: 1000 },
  { min: 1_000_000, tick: 500 },
  { min: 500_000, tick: 100 },
  { min: 100_000, tick: 50 },
  { min: 10_000, tick: 10 },
  { min: 1_000, tick: 5 },
  { min: 100, tick: 1 },
  { min: 10, tick: 0.1 },
  { min: 1, tick: 0.01 },
  { min: 0.1, tick: 0.001 },
  { min: 0.01, tick: 0.0001 },
  { min: 0, tick: 0.00001 },
];

/** Upbit KRW tick size at a given price. */
export function krwTickSize(price: number): number {
  const p = Math.abs(price);
  for (const t of KRW_TIERS) if (p >= t.min) return t.tick;
  return KRW_TIERS[KRW_TIERS.length - 1]!.tick;
}
