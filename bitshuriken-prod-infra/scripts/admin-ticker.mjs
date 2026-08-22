#!/usr/bin/env node
// 내부/봇용 ticker 운영 CLI — secret key 인증. 리스팅/디리스팅/상태변경/신규생성.
// 차익거래·그리드봇 테스트용 (BTC1/USDT 같은 합성 마켓 생성).
//
// 인증: env ADMIN_API_SECRET (BE의 ADMIN_API_SECRET과 동일). X-Admin-Secret 헤더로 전송.
// 대상:  env PORTAL_URL (기본 http://localhost:5103)
//
// 사용:
//   node scripts/admin-ticker.mjs list
//   node scripts/admin-ticker.mjs status <spot|futures> <SYMBOL> <PENDING|TRADING|HALTED|DELISTED>
//   node scripts/admin-ticker.mjs open|halt|delist <spot|futures> <SYMBOL>
//   node scripts/admin-ticker.mjs create <spot|futures> <BASE> <QUOTE> <pricePrec> <qtyPrec> [--status TRADING] [--name "..."]
//
// create는 DB 등록 + tickers.json 추가까지 한다. 파티션은 FNV-1a(symbol)%P 고정 버킷이라
// 증설 불필요. 실제 거래까지는 매칭엔진/Nest 앱 재시작 후 status를 TRADING으로 연다(안내).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 기본값: 이 infra 레포와 나란히 체크아웃된 match 레포. 다른 레이아웃은 TICKERS_JSON으로 오버라이드.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TICKERS_JSON =
  process.env.TICKERS_JSON ?? join(REPO_ROOT, 'bitshuriken-prod-match', 'config', 'tickers.json');

const PORTAL_URL = (process.env.PORTAL_URL ?? 'http://localhost:5103').replace(/\/$/, '');
const SECRET = process.env.ADMIN_API_SECRET;
const STATUSES = ['PENDING', 'TRADING', 'HALTED', 'DELISTED'];

// 파티션 버킷 = FNV-1a(symbol) % P. P는 infra의 MATCH_*_PARTITIONS와 동일해야 한다.
const MATCH_PARTITIONS = {
  spot: Number(process.env.MATCH_SPOT_PARTITIONS ?? 6),
  futures: Number(process.env.MATCH_FUTURES_PARTITIONS ?? 6),
};
function fnv1a32(input) {
  let h = 0x811c9dc5;
  const bytes = Buffer.from(input, 'utf8');
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function partitionForSymbol(symbol, partitions) {
  return fnv1a32(symbol) % partitions;
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function requireSecret() {
  if (!SECRET) die('ADMIN_API_SECRET env is required (must match the backend value)');
}

async function api(method, path, body) {
  requireSecret();
  const res = await fetch(`${PORTAL_URL}${path}`, {
    method,
    headers: {
      'X-Admin-Secret': SECRET,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const m = payload?.message ?? `${res.status} ${res.statusText}`;
    die(`${method} ${path} -> ${m}${payload?.code ? ` (code ${payload.code})` : ''}`);
  }
  return payload?.data;
}

function normalizeMarket(raw) {
  const m = String(raw ?? '').toLowerCase();
  if (m !== 'spot' && m !== 'futures') die(`market must be 'spot' or 'futures', got: ${raw}`);
  return m;
}

function readTickersConfig() {
  const parsed = JSON.parse(readFileSync(TICKERS_JSON, 'utf-8'));
  if (!Array.isArray(parsed.tickers)) die(`${TICKERS_JSON}: missing "tickers" array`);
  return parsed;
}

async function cmdList() {
  const tickers = await api('GET', '/admin/tickers');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('SYMBOL', 14) + pad('MARKET', 9) + pad('STATUS', 10) + pad('PREC', 8) + 'PART');
  for (const t of tickers) {
    console.log(
      pad(t.symbol, 14) +
        pad(t.marketType, 9) +
        pad(t.status, 10) +
        pad(`${t.pricePrecision}/${t.qtyPrecision}`, 8) +
        t.partition,
    );
  }
}

async function cmdStatus(market, symbol, status) {
  const m = normalizeMarket(market);
  if (!symbol) die('symbol required');
  const s = String(status ?? '').toUpperCase();
  if (!STATUSES.includes(s)) die(`status must be one of ${STATUSES.join('|')}`);
  const out = await api('PATCH', `/admin/tickers/${m}/${symbol.toUpperCase()}/status`, { status: s });
  console.log(`${out.symbol} (${out.marketType}): ${out.previousStatus} -> ${out.status}`);
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--status') flags.status = String(args[++i] ?? '').toUpperCase();
    else if (a === '--name') flags.name = args[++i];
    else positional.push(a);
  }
  return { flags, positional };
}

async function cmdCreate(args) {
  const { flags, positional } = parseFlags(args);
  const [marketRaw, baseRaw, quoteRaw, priceRaw, qtyRaw] = positional;
  const market = normalizeMarket(marketRaw);
  const base = String(baseRaw ?? '').toUpperCase();
  const quote = String(quoteRaw ?? '').toUpperCase();
  const pricePrecision = Number(priceRaw);
  const qtyPrecision = Number(qtyRaw);
  if (!base || !quote) die('usage: create <spot|futures> <BASE> <QUOTE> <pricePrec> <qtyPrec>');
  if (!Number.isInteger(pricePrecision) || !Number.isInteger(qtyPrecision))
    die('pricePrec and qtyPrec must be integers');
  if (pricePrecision + qtyPrecision > 8) die('pricePrecision + qtyPrecision must be <= 8');
  const status = flags.status ?? 'PENDING';
  if (!STATUSES.includes(status)) die(`--status must be one of ${STATUSES.join('|')}`);
  const symbol = `${base}${quote}`;

  // 1. partition = FNV-1a(symbol) % P (config·seed·엔진과 동일한 결정적 버킷)
  const config = readTickersConfig();
  const inMarket = config.tickers.filter((t) => t.market === market);
  if (inMarket.some((t) => t.symbol === symbol))
    die(`${symbol} already in tickers.json (${market})`);
  const partition = partitionForSymbol(symbol, MATCH_PARTITIONS[market]);

  // 2. DB 등록 (검증·중복확인의 권위 소스)
  const created = await api('POST', '/admin/tickers', {
    market: market.toUpperCase(),
    baseAsset: base,
    quoteAsset: quote,
    pricePrecision,
    qtyPrecision,
    partition,
    status,
    ...(flags.name ? { baseName: flags.name } : {}),
  });
  console.log(`DB: registered ${created.symbol} (${created.marketType}) partition=${created.partition} status=${created.status}`);

  // 3. tickers.json 추가 (엔진 lane 소스)
  config.tickers.push({ market, symbol, partition, pricePrecision, qtyPrecision });
  writeFileSync(TICKERS_JSON, JSON.stringify(config, null, 2) + '\n');
  console.log(`config: added to ${TICKERS_JSON}`);

  console.log('\nNext steps to make it tradable:');
  console.log('  1) Restart the match engine (lane registry loads config at boot)');
  console.log('  2) Restart the Nest apps (ticker meta cache loads at boot)');
  if (status !== 'TRADING')
    console.log(`  3) node scripts/admin-ticker.mjs open ${market} ${symbol}`);
}

function usage() {
  console.log(
    [
      'admin-ticker — ticker listing/delisting via service secret',
      '',
      'env: ADMIN_API_SECRET (required), PORTAL_URL (default http://localhost:5103)',
      '',
      'commands:',
      '  list',
      '  status <spot|futures> <SYMBOL> <PENDING|TRADING|HALTED|DELISTED>',
      '  open|halt|delist <spot|futures> <SYMBOL>',
      '  create <spot|futures> <BASE> <QUOTE> <pricePrec> <qtyPrec> [--status TRADING] [--name "..."]',
    ].join('\n'),
  );
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'list':
      return cmdList();
    case 'status':
      return cmdStatus(rest[0], rest[1], rest[2]);
    case 'open':
      return cmdStatus(rest[0], rest[1], 'TRADING');
    case 'halt':
      return cmdStatus(rest[0], rest[1], 'HALTED');
    case 'delist':
      return cmdStatus(rest[0], rest[1], 'DELISTED');
    case 'create':
      return cmdCreate(rest);
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
