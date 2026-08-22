import 'dotenv/config';
import type { Market } from './types';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
function num(name: string, dflt: number): number {
  const v = process.env[name];
  return v === undefined ? dflt : Number(v);
}
// optional comma list — empty/unset → [] (lets a caller mirror one market only).
function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export interface SymbolRef {
  symbol: string;
  market: Market;
}

export const config = {
  // Lazy getters: `npm run check` reads spot/futures depth + DB only, so PORTAL_API
  // (launcher only) must not be required just to import config.
  api: {
    get spot() {
      return req('SPOT_API');
    },
    get futures() {
      return req('FUTURES_API');
    },
    get portal() {
      return req('PORTAL_API');
    },
  },
  // integrity checker only (npm run check / scan) — the launcher never touches the DB.
  databaseUrl: process.env.DATABASE_URL ?? '',
  accounts: {
    makerEmail: process.env.MAKER_EMAIL ?? 'maker-bot@bots.local',
    takerEmail: process.env.TAKER_EMAIL ?? 'taker-bot@bots.local',
    password: process.env.BOT_PASSWORD ?? 'botpassword123',
  },
  // operator secret used to flag the maker/taker accounts rate-limit exempt on boot (ADR-066).
  adminSecret: process.env.ADMIN_API_SECRET ?? '',
  tuning: {
    depthLevels: num('DEPTH_LEVELS', 50), // deep buffer: a fast move can churn the whole visible top-20
    reconcileMs: num('RECONCILE_MS', 250), // maker pass pacing (min gap between diff passes)
    resyncMs: num('RESYNC_MS', 5_000), // maker open-orders resync cadence (also clears PO-reject phantoms)
    qtyTolerance: num('QTY_TOLERANCE', 0.2),
    passOpsCap: num('MAKER_PASS_OPS_CAP', 15), // max levels touched per side per maker pass (feedback-027 walk)
    takerMaxQtyFrac: num('TAKER_MAX_QTY_FRAC', 0.6),
    takerMaxTps: num('TAKER_MAX_TPS', 8),
    futuresLeverage: num('FUTURES_LEVERAGE', 10),
    futuresMaxNotional: num('FUTURES_MAX_NOTIONAL', 1_000_000),
  },
  symbols: ((): SymbolRef[] => {
    const spot = list('SPOT_SYMBOLS').map((symbol) => ({ symbol, market: 'SPOT' as Market }));
    const fut = list('FUTURES_SYMBOLS').map((symbol) => ({ symbol, market: 'FUTURES' as Market }));
    return [...spot, ...fut];
  })(),
};

/** base URL for a given local market app. */
export function apiBase(market: Market): string {
  return market === 'SPOT' ? config.api.spot : config.api.futures;
}
