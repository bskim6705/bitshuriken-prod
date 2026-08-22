import { Decimal } from '@prisma/client/runtime/library';

// Upbit KRW-market tiered price units, reproduced as-is (ADR-066). Upbit's tick size is a step
// function of price, not a single value; KRW-quote tickers are validated against this table
// instead of a flat tick. Mirror of bitshuriken-prod-bots/src/krw-ticks.ts — keep in sync.

interface Tier {
  min: Decimal; // price >= min uses this tick (descending scan)
  tick: Decimal;
}

const D = (v: string): Decimal => new Decimal(v);

// Descending by min. Source: Upbit KRW market order-price-unit table (docs.upbit.com
// krw-market-info), cross-checked against live Upbit orderbooks per tier (2026-07).
const KRW_TIERS: Tier[] = [
  { min: D('1000000'), tick: D('1000') },
  { min: D('500000'), tick: D('500') },
  { min: D('100000'), tick: D('100') },
  { min: D('50000'), tick: D('50') },
  { min: D('10000'), tick: D('10') },
  { min: D('5000'), tick: D('5') },
  { min: D('100'), tick: D('1') },
  { min: D('10'), tick: D('0.1') },
  { min: D('1'), tick: D('0.01') },
  { min: D('0.1'), tick: D('0.001') },
  { min: D('0.01'), tick: D('0.0001') },
  { min: D('0.001'), tick: D('0.00001') },
  { min: D('0.0001'), tick: D('0.000001') },
  { min: D('0.00001'), tick: D('0.0000001') },
  { min: D('0'), tick: D('0.00000001') },
];

/** Upbit KRW tick size at a given price. */
export function krwTickSize(price: Decimal): Decimal {
  const p = price.abs();
  for (const t of KRW_TIERS) if (p.gte(t.min)) return t.tick;
  return KRW_TIERS[KRW_TIERS.length - 1].tick;
}

/** is a KRW price aligned to its tier's tick grid? */
export function isKrwTickAligned(price: Decimal): boolean {
  return price.mod(krwTickSize(price)).isZero();
}

/** the tiered price-unit table for exchange-info (descending by minPrice), as fixed strings. */
export function krwTierTable(): { minPrice: string; tickSize: string }[] {
  return KRW_TIERS.map((t) => ({ minPrice: t.min.toFixed(), tickSize: t.tick.toFixed() }));
}
