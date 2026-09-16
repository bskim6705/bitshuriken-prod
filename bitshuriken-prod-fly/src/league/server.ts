import { createServer, type Server } from 'node:http';
import { CORS, serveStatic } from '../server';
import type { League } from './league';

/** 리그 대시보드: `/` → league.html, `GET /api/league`, `GET /api/fly/:slot`. */
export function createLeagueServer(league: League): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.pathname === '/api/league') return json(200, { ok: true, data: league.summary() });
      const m = /^\/api\/fly\/(\d+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) return json(200, { ok: true, data: league.flyStatus(Number(m[1])) });
      const path = url.pathname === '/' ? '/league.html' : url.pathname;
      if (req.method === 'GET' && (await serveStatic(res, path))) return;
      json(404, { ok: false, error: `no route ${req.method} ${url.pathname}` });
    })();
  });
}
