import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlyLive } from './trade/live';
import type { LobLive } from './trade/lob-live';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
/** 읽기 전용 관전 데이터 — FE(다른 오리진)가 그대로 가져갈 수 있게 연다. */
export const CORS = { 'Access-Control-Allow-Origin': '*' } as const;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

export async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.includes('..')) return false;
  try {
    const buf = await readFile(resolve(WEB_DIR, rel));
    res.writeHead(200, { 'Content-Type': MIME[rel.slice(rel.lastIndexOf('.'))] ?? 'application/octet-stream' });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

/** 대시보드(정적) + `GET /api/state`. 인증 없음 — localhost 전용. */
export function createFlyServer(live: FlyLive | LobLive): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: true, data: live.view() }));
        return;
      }
      if (req.method === 'GET' && (await serveStatic(res, url.pathname))) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `no route ${req.method} ${url.pathname}` }));
    })();
  });
}
