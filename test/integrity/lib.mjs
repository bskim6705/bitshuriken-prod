// Live integrity-test toolkit. Drives the RUNNING services (not the jest harness),
// so it exercises the full BE -> Kafka -> Python match -> Kafka -> settlement pipeline.
// Money math uses Decimal-free exact arithmetic on 8dp via BigInt scaled by 10^8.
import crypto from 'node:crypto';

export const BASE = {
  portal: 'http://localhost:5103',
  spot: 'http://localhost:5101',
  futures: 'http://localhost:5102',
  dex: 'http://localhost:5107',
  options: 'http://localhost:5108',
};

export const SCALE = 100000000n; // 10^8

// rate-limit 면제 토큰(ADR-060). limiter-on 데모에서도 하니스 전 요청(공개 parity 포함)을 면제.
// 1차 보호는 테스트 프로파일의 RATE_LIMIT_ENABLED=false. 둘 다 있으면 belt-and-suspenders.
const INTERNAL_TOKEN = process.env.IT_INTERNAL_TOKEN ?? '';
const internalHeader = () => (INTERNAL_TOKEN ? { 'X-Internal-Token': INTERNAL_TOKEN } : {});

// ---- exact 8dp money helpers (BigInt scaled int) ----
export const toScaled = (v) => {
  let s = String(v).trim();
  if (/e/i.test(s)) s = Number(s).toFixed(8); // expand scientific notation (e.g. 1e-8) — exact for test magnitudes
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const frac = (f + '00000000').slice(0, 8);
  const n = BigInt(i || '0') * SCALE + BigInt(frac || '0');
  return neg ? -n : n;
};
export const fromScaled = (n) => {
  const neg = n < 0n;
  const a = neg ? -n : n;
  const i = a / SCALE;
  const f = (a % SCALE).toString().padStart(8, '0');
  return `${neg ? '-' : ''}${i}.${f}`;
};

// ---- HMAC signing (matches ApiKeyOnlyGuard: HMAC-SHA256(queryString_without_signature + body, secret) hex) ----
export const hmac = (secret, qs, body = '') =>
  crypto.createHmac('sha256', secret).update(qs + body).digest('hex');

async function parse(res) {
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() ?? [] };
}

// signed (API-key) request. query is an object; timestamp appended automatically.
export async function signed(base, method, path, { apiKey, secret, query = {}, body }) {
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const qs = new URLSearchParams({ ...query, timestamp: String(Date.now()) }).toString();
  const sig = hmac(secret, qs, bodyStr);
  const url = `${base}${path}?${qs}&signature=${sig}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-API-KEY': apiKey, ...internalHeader(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: bodyStr } : {}),
  });
  return parse(res);
}

// JWT/session-cookie request (for admin + escalation-blocked endpoints).
export async function jwt(base, method, path, { cookie, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...internalHeader(),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return parse(res);
}

const cookieFrom = (setCookie) => {
  const c = (setCookie || []).find((x) => x.startsWith('bs_session='));
  return c ? c.split(';')[0] : null;
};

// ---- high-level account primitives ----
export async function signup(email, password = 'password123') {
  const r = await jwt(BASE.portal, 'POST', '/auth/signup', { body: { email, password } });
  if (r.status !== 201) throw new Error(`signup ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  return { userId: r.json.data.id, cookie: cookieFrom(r.setCookie), email };
}
export async function login(email, password = 'password123') {
  const r = await jwt(BASE.portal, 'POST', '/auth/login', { body: { email, password } });
  if (r.status >= 300) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  return { cookie: cookieFrom(r.setCookie), userId: r.json?.data?.id ?? r.json?.data?.userId ?? null };
}
export async function issueApiKey(cookie, { canTrade = true, canRead = true, label = 'integrity' } = {}) {
  const r = await jwt(BASE.portal, 'POST', '/auth/api-keys', { cookie, body: { label, canTrade, canRead } });
  if (r.status !== 201) throw new Error(`issueApiKey: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data; // { apiKey, secret, ... }
}
export async function deposit(key, assetSymbol, qty) {
  const r = await signed(BASE.portal, 'POST', '/account/deposits', {
    apiKey: key.apiKey, secret: key.secret, body: { assetSymbol, qty },
  });
  if (r.status !== 201) throw new Error(`deposit ${assetSymbol} ${qty}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data;
}

// Convenience: create a fully funded trader.
export async function makeTrader(tag, funding = {}) {
  const email = `it-${tag}-${Date.now()}-${Math.floor(performance.now())}@itest.local`;
  const { userId, cookie } = await signup(email);
  const key = await issueApiKey(cookie, { canTrade: true, canRead: true });
  for (const [asset, qty] of Object.entries(funding)) await deposit(key, asset, qty);
  return { email, userId, cookie, key };
}

// Fetch the email-verification token from mailpit and confirm it (also exercises the verify flow).
export async function verifyEmail(email) {
  const search = await fetch('http://localhost:5112/api/v1/search?query=' + encodeURIComponent('to:' + email));
  const list = await search.json();
  const msg = (list.messages || []).find((m) => /verify/i.test(m.Subject));
  if (!msg) throw new Error(`no verify email for ${email}`);
  const full = await (await fetch('http://localhost:5112/api/v1/message/' + msg.ID)).json();
  const body = (full.Text || '') + ' ' + (full.HTML || '');
  const tok = body.match(/token=([A-Za-z0-9._%-]+)/);
  if (!tok) throw new Error('no token in verify email');
  const r = await jwt(BASE.portal, 'POST', '/auth/verify-email', { body: { token: decodeURIComponent(tok[1]) } });
  if (r.status >= 300) throw new Error(`verify-email failed: ${r.status} ${JSON.stringify(r.json)}`);
  return true;
}

export async function transfer(key, fromMarket, toMarket, assetSymbol, qty) {
  const r = await signed(BASE.portal, 'POST', '/account/transfers', {
    apiKey: key.apiKey, secret: key.secret, body: { fromMarket, toMarket, assetSymbol, qty },
  });
  if (r.status !== 201) throw new Error(`transfer ${fromMarket}->${toMarket} ${assetSymbol} ${qty}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data;
}
export async function loginAdmin(email = 'admin@test.com', password = 'password123') {
  const { cookie } = await login(email, password);
  if (!cookie) throw new Error('admin login returned no session cookie');
  return cookie;
}
// normalize a balances array -> {ASSET:{free,locked,total}}.
// NOTE: /spot/account/balances returns ALL markets' wallet rows; pass `market` to filter
// (rows have marketType), else USDT rows from different markets collide. DEX endpoint rows
// have no marketType and are returned as-is.
export function normBalances(arr, market) {
  const m = {};
  for (const b of arr || []) {
    const a = b.assetSymbol ?? b.asset;
    if (!a) continue;
    if (market && b.marketType && b.marketType !== market) continue;
    m[a] = { free: toScaled(b.balance), locked: toScaled(b.locked ?? '0'), total: toScaled(b.balance) + toScaled(b.locked ?? '0') };
  }
  return m;
}
export const at = (m, a) => m[a] ?? { free: 0n, locked: 0n, total: 0n };

// ---- assertions / reporting ----
export function makeReport(suite) {
  const cases = [];
  return {
    check(name, pass, detail = '') { cases.push({ name, pass: !!pass, detail });
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return !!pass; },
    eqScaled(name, a, b, tolScaled = 0n) {
      const A = typeof a === 'bigint' ? a : toScaled(a), B = typeof b === 'bigint' ? b : toScaled(b);
      const d = A > B ? A - B : B - A;
      return this.check(name, d <= tolScaled, `Δ=${fromScaled(d)} (a=${fromScaled(A)} b=${fromScaled(B)})`);
    },
    done() {
      const fail = cases.filter((c) => !c.pass);
      const out = { suite, total: cases.length, passed: cases.length - fail.length, failed: fail.length, cases };
      console.log(`\n[${suite}] ${out.passed}/${out.total} passed${fail.length ? `, ${fail.length} FAILED` : ''}\n`);
      return out;
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a predicate until true or timeout. fn returns truthy when done.
export async function poll(fn, { tries = 40, intervalMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}
