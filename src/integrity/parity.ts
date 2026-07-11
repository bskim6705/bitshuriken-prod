import ccxt from 'ccxt';
import { apiBase } from '../config';
import { sourceOf, type Market, type MirrorSource, type SymbolSpec } from '../types';
import type { CheckResult, Status } from './db';

const MID_WARN_BPS = 50; // local mid within 0.5% of source mid → healthy mirror

// shared REST clients for source parity reads
const clients = {
  BINANCE_SPOT: new ccxt.binance({ enableRateLimit: true }),
  BINANCE_FUTURES: new ccxt.binanceusdm({ enableRateLimit: true }),
  UPBIT_SPOT: new ccxt.upbit({ enableRateLimit: true }),
};

interface Book {
  bid: number;
  ask: number;
}

function unified(source: MirrorSource, market: Market, spec: SymbolSpec): string {
  const base = `${spec.baseAsset}/${spec.quoteAsset}`;
  if (source === 'BINANCE' && market === 'FUTURES') return `${base}:${spec.quoteAsset}`;
  return base;
}

async function localBook(market: Market, symbol: string): Promise<Book | null> {
  const path = market === 'SPOT' ? '/spot/market/depth' : '/futures/market/depth';
  const res = await fetch(`${apiBase(market)}${path}?symbol=${symbol}&limit=5`);
  if (!res.ok) return null;
  const env = (await res.json()) as { data: { bids: [string, string][]; asks: [string, string][] } };
  const b = env.data.bids[0];
  const a = env.data.asks[0];
  if (!b || !a) return null;
  return { bid: Number(b[0]), ask: Number(a[0]) };
}

async function sourceBook(source: MirrorSource, market: Market, spec: SymbolSpec): Promise<Book | null> {
  const ex =
    source === 'UPBIT'
      ? clients.UPBIT_SPOT
      : market === 'SPOT'
        ? clients.BINANCE_SPOT
        : clients.BINANCE_FUTURES;
  const ob = await ex.fetchOrderBook(unified(source, market, spec), 5);
  const b = ob.bids[0];
  const a = ob.asks[0];
  if (!b || !a || b[0] == null || a[0] == null) return null;
  return { bid: Number(b[0]), ask: Number(a[0]) };
}

const mid = (b: Book): number => (b.bid + b.ask) / 2;

async function paritySymbol(spec: SymbolSpec): Promise<CheckResult> {
  const source = sourceOf(spec);
  const tag = `${spec.market === 'FUTURES' ? 'F:' : ''}${spec.symbol}`;
  const [loc, src] = await Promise.all([
    localBook(spec.market, spec.symbol).catch(() => null),
    sourceBook(source, spec.market, spec).catch(() => null),
  ]);

  if (!loc) return { name: `PAR ${tag}`, status: 'warn', detail: 'no local liquidity yet' };
  if (loc.bid >= loc.ask) {
    return { name: `PAR ${tag}`, status: 'fail', detail: `LOCAL BOOK CROSSED: bid ${loc.bid} ≥ ask ${loc.ask}` };
  }
  if (!src) return { name: `PAR ${tag}`, status: 'warn', detail: `local mid ${mid(loc)} (${source} unreachable)` };
  const bps = (Math.abs(mid(loc) - mid(src)) / mid(src)) * 1e4;
  const status: Status = bps <= MID_WARN_BPS ? 'pass' : 'warn';
  return {
    name: `PAR ${tag}`,
    status,
    detail: `local ${mid(loc).toFixed(2)} vs ${source} ${mid(src).toFixed(2)} — ${bps.toFixed(1)} bps`,
  };
}

/** discover every listed ticker from exchange-info (the mirror set is whatever the exchange lists). */
async function discover(market: Market): Promise<SymbolSpec[]> {
  const path = market === 'SPOT' ? '/spot/market/exchange-info' : '/futures/market/exchange-info';
  const res = await fetch(`${apiBase(market)}${path}`);
  if (!res.ok) return [];
  const env = (await res.json()) as {
    data: {
      symbols: {
        symbol: string;
        baseAsset: string;
        quoteAsset: string;
        pricePrecision: number;
        qtyPrecision: number;
        tickSize: string;
        stepSize: string;
        minNotional: string;
      }[];
    };
  };
  return env.data.symbols.map((s) => ({
    symbol: s.symbol,
    market,
    baseAsset: s.baseAsset,
    quoteAsset: s.quoteAsset,
    pricePrecision: s.pricePrecision,
    qtyPrecision: s.qtyPrecision,
    tickSize: Number(s.tickSize),
    stepSize: Number(s.stepSize),
    minNotional: Number(s.minNotional),
  }));
}

export async function runParity(): Promise<CheckResult[]> {
  const [spot, fut] = await Promise.all([discover('SPOT'), discover('FUTURES')]);
  const targets = [...spot, ...fut];
  return Promise.all(targets.map(paritySymbol));
}
