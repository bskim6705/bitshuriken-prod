import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config';
import { makeLogger } from '../core/logger';
import type { Market } from '../core/types';
import type { Supervisor } from '../fleet/supervisor';
import { store } from '../metrics/store';
import { getKlines, computeIndicators } from '../data/marketdata';
import { signalScan } from '../indicators/scan';

const log = makeLogger('control');

type Handler = (params: Record<string, string>, query: URLSearchParams, body: Record<string, unknown>) => Promise<unknown> | unknown;
interface Route {
  method: string;
  parts: string[]; // path segments, ':x' = param
  handler: Handler;
}

const num = (v: string | null, dflt: number): number => {
  if (v === null) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt; // lenient on query input
};
const market = (v: string | null): Market => (v === 'FUTURES' ? 'FUTURES' : 'SPOT');
const source = (v: string | null): 'local' | 'binance' => (v === 'binance' ? 'binance' : 'local');

// static dashboard (served same-origin so the browser needs no CORS)
const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.includes('..')) return false;
  try {
    const buf = await readFile(resolve(WEB_DIR, rel));
    const ext = rel.slice(rel.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

/** Long-running control surface for the fleet. Localhost JSON; `{ok,data}` / `{ok:false,error}`. */
export function createControlServer(sup: Supervisor): Server {
  const routes: Route[] = [
    { method: 'GET', parts: ['health'], handler: () => ({ ok: true, uptimeMs: Date.now() - sup.startedAt, agents: sup.listAgents().length, strategies: sup.listStrategies().length }) },
    { method: 'GET', parts: ['strategies'], handler: () => sup.listStrategies() },
    { method: 'POST', parts: ['strategies', 'reload'], handler: (_p, _q, b) => sup.reloadStrategies(b.file as string | undefined) },
    { method: 'GET', parts: ['agents'], handler: () => sup.listAgents() },
    { method: 'POST', parts: ['agents'], handler: (_p, _q, b) => sup.startAgent(b as never) },
    { method: 'GET', parts: ['agents', ':id'], handler: (p) => sup.agentStatus(p.id!) },
    { method: 'POST', parts: ['agents', ':id', 'stop'], handler: (p, _q, b) => sup.stopAgent(p.id!, b.flatten !== false).then(() => ({ stopped: p.id })) },
    { method: 'POST', parts: ['agents', ':id', 'params'], handler: (p, _q, b) => sup.tuneAgent(p.id!, (b.params ?? {}) as never) },
    { method: 'GET', parts: ['agents', ':id', 'metrics'], handler: (p) => sup.agentMetrics(p.id!) },
    { method: 'GET', parts: ['integrity'], handler: () => sup.integrityAll() },
    { method: 'GET', parts: ['agents', ':id', 'integrity'], handler: (p) => sup.agentIntegrity(p.id!) },
    { method: 'POST', parts: ['compare'], handler: (_p, _q, b) => sup.compare(b as never) },
    { method: 'POST', parts: ['backtest'], handler: (_p, _q, b) => sup.backtest(b as never) },
    { method: 'GET', parts: ['backtests'], handler: () => store.listBacktests() },
    { method: 'GET', parts: ['tickers'], handler: () => sup.bots.listTickers() },
    { method: 'POST', parts: ['tickers', 'ensure'], handler: (_p, _q, b) => sup.bots.ensureTradable(b.symbol as string, market((b.market as string) ?? null)) },
    { method: 'GET', parts: ['mirrors'], handler: () => sup.bots.list() },
    { method: 'POST', parts: ['mirrors'], handler: (_p, _q, b) => sup.bots.startMirror(b.symbol as string, market((b.market as string) ?? null)) },
    { method: 'POST', parts: ['mirrors', 'stop'], handler: (_p, _q, b) => sup.bots.stopMirror(b.symbol as string, market((b.market as string) ?? null)) },
    {
      method: 'GET',
      parts: ['klines'],
      handler: (_p, q) =>
        getKlines({ market: market(q.get('market')), symbol: q.get('symbol')!, interval: q.get('interval') ?? config.live.klineInterval, limit: num(q.get('limit'), 200), source: source(q.get('source')), endTime: q.get('endTime') ? Number(q.get('endTime')) : undefined }),
    },
    {
      method: 'GET',
      parts: ['signal-scan'],
      handler: async (_p, q) => {
        const interval = q.get('interval') ?? config.live.klineInterval;
        const bars = await getKlines({ market: market(q.get('market')), symbol: q.get('symbol')!, interval, limit: num(q.get('lookback'), 200), source: source(q.get('source')) });
        return signalScan(q.get('symbol')!, interval, bars);
      },
    },
    {
      method: 'GET',
      parts: ['indicators'],
      handler: async (_p, q) => {
        const bars = await getKlines({ market: market(q.get('market')), symbol: q.get('symbol')!, interval: q.get('interval') ?? config.live.klineInterval, limit: num(q.get('lookback'), 200), source: source(q.get('source')) });
        return computeIndicators(bars);
      },
    },
  ];

  return createServer((req, res) => void handle(req, res, routes));
}

async function handle(req: IncomingMessage, res: ServerResponse, routes: Route[]): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segs = url.pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== req.method || r.parts.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < r.parts.length; i++) {
      const part = r.parts[i]!;
      if (part.startsWith(':')) params[part.slice(1)] = segs[i]!;
      else if (part !== segs[i]) { ok = false; break; }
    }
    if (!ok) continue;
    try {
      const body = req.method === 'GET' ? {} : await readJson(req);
      const data = await r.handler(params, url.searchParams, body);
      send(res, 200, { ok: true, data });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`${req.method} ${url.pathname} → ${msg}`);
      send(res, 400, { ok: false, error: msg });
    }
    return;
  }
  if (req.method === 'GET' && (await serveStatic(res, url.pathname))) return; // dashboard assets
  send(res, 404, { ok: false, error: `no route ${req.method} ${url.pathname}` });
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}
