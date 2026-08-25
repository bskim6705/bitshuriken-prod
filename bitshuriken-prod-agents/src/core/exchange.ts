import * as crypto from 'crypto';
import { config, apiBase } from '../config';
import type {
  AccountTrade,
  Balance,
  Bar,
  DepthSnapshot,
  LocalOrder,
  Market,
  Side,
  SymbolSpec,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

interface ExchangeInfoSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  qtyPrecision: number;
  tickSize: string;
  stepSize: string;
  minNotional: string;
}

interface RawKline {
  openTime: number;
  closeTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  isFinal?: boolean;
}

/** Issued credential for one subaccount — what the agent trades with. */
export interface SubaccountCreds {
  apiKey: string;
  secret: string;
}

export interface SubaccountSummary {
  id: string;
  label: string | null;
  feeMakerBps: number;
  feeTakerBps: number;
}

// rate-limit 면제 토큰(ADR-060). BE의 RATE_LIMIT_INTERNAL_TOKEN과 동일 값. 모든 요청(공개 klines 폴링 포함)에 첨부.
const INTERNAL_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? '';
const MAX_RL_RETRIES = 5;
const rlSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Low-level fetch + `{code,message,data}` envelope unwrap (shared across clients). */
export async function request<T>(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ data: T; res: Response }> {
  const h = INTERNAL_TOKEN ? { ...headers, 'X-Internal-Token': INTERNAL_TOKEN } : headers;
  // 멱등 호출(GET/DELETE)만 429/418에서 Retry-After 백오프 재시도. 주문 POST는 재시도 안 함.
  const retryable = method === 'GET' || method === 'DELETE';
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers: h, body });
    if ((res.status === 429 || res.status === 418) && retryable && attempt < MAX_RL_RETRIES) {
      const ra = Number(res.headers.get('Retry-After')) || 1;
      await rlSleep(ra * 1000 + Math.random() * 250);
      continue;
    }
    let payload: Envelope<T> | null = null;
    try {
      payload = (await res.json()) as Envelope<T>;
    } catch {
      /* non-JSON (e.g. 204) */
    }
    if (!res.ok || (payload && payload.code !== 0)) {
      const msg = payload?.message ?? `${res.status} ${res.statusText}`;
      throw new ApiError(`${method} ${url} → ${msg}`, res.status, payload?.code ?? null);
    }
    return { data: (payload as Envelope<T> | null)?.data as T, res };
  }
}

const mapSymbols = (rows: ExchangeInfoSymbol[], market: Market): SymbolSpec[] =>
  rows.map((s) => ({
    symbol: s.symbol,
    market,
    pricePrecision: s.pricePrecision,
    qtyPrecision: s.qtyPrecision,
    tickSize: Number(s.tickSize),
    stepSize: Number(s.stepSize),
    minNotional: Number(s.minNotional),
    baseAsset: s.baseAsset,
    quoteAsset: s.quoteAsset,
  }));

const mapKlines = (rows: RawKline[]): Bar[] =>
  rows.map((k) => ({
    openTime: k.openTime,
    open: Number(k.open),
    high: Number(k.high),
    low: Number(k.low),
    close: Number(k.close),
    volume: Number(k.volume),
    closeTime: k.closeTime,
    isFinal: k.isFinal ?? true,
  }));

/** GET a public (no-auth) market endpoint. */
async function publicGet<T>(base: string, path: string): Promise<T> {
  const { data } = await request<T>(`${base}${path}`, 'GET', {});
  return data;
}

async function exchangeInfo(market: Market): Promise<SymbolSpec[]> {
  const path = market === 'SPOT' ? '/spot/market/exchange-info' : '/futures/market/exchange-info';
  const data = await publicGet<{ symbols: ExchangeInfoSymbol[] }>(apiBase(market), path);
  return mapSymbols(data.symbols, market);
}

async function depth(market: Market, symbol: string, limit = 50): Promise<DepthSnapshot> {
  const path = market === 'SPOT' ? '/spot/market/depth' : '/futures/market/depth';
  const data = await publicGet<{ bids: [string, string][]; asks: [string, string][] }>(
    apiBase(market),
    `${path}?symbol=${symbol}&limit=${limit}`,
  );
  const map = (l: [string, string][]): [number, number][] => l.map(([p, q]) => [Number(p), Number(q)]);
  return { bids: map(data.bids), asks: map(data.asks) };
}

/** Public local klines. Oldest→newest; last bar may be partial (isFinal=false). */
async function klines(
  market: Market,
  symbol: string,
  interval: string,
  limit = 500,
  endTime?: number,
): Promise<Bar[]> {
  const path = market === 'SPOT' ? '/spot/market/klines' : '/futures/market/klines';
  const q = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (endTime !== undefined) q.set('endTime', String(endTime));
  return mapKlines(await publicGet<RawKline[]>(apiBase(market), `${path}?${q.toString()}`));
}

/** pull the bs_session JWT out of a login/signup response's Set-Cookie. */
function extractSessionToken(res: Response): string | null {
  const getter = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getter === 'function' ? getter.call(res.headers) : [];
  const raw = cookies.length ? cookies : [res.headers.get('set-cookie') ?? ''];
  for (const c of raw) {
    if (c.startsWith('bs_session=')) {
      return decodeURIComponent(c.slice('bs_session='.length).split(';')[0]!);
    }
  }
  return null;
}

/**
 * The master account that owns every agent subaccount. Authenticates with a JWT
 * (session cookie / Bearer) and only ever calls the `/subaccounts` management surface
 * and dev funding — it never trades.
 */
export class MasterClient {
  private token: string | null = null;
  userId: string | null = null;

  /** login if the account exists, else signup; stores the JWT + master userId. */
  async ensureAccount(email: string, password: string): Promise<void> {
    try {
      await this.auth('/auth/login', email, password);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
        await this.auth('/auth/signup', email, password);
      } else {
        throw e;
      }
    }
  }

  private async auth(path: string, email: string, password: string): Promise<void> {
    const { data, res } = await request<{ id: string }>(
      `${config.api.portal}${path}`,
      'POST',
      { 'Content-Type': 'application/json' },
      JSON.stringify({ email, password }),
    );
    this.userId = data.id;
    this.token = extractSessionToken(res);
    if (!this.token) throw new Error(`master: no session token from ${path}`);
  }

  private async jwt<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const { data } = await request<T>(`${base}${path}`, method, headers, payload);
    return data;
  }

  /** dev-only instant deposit into the master's SPOT wallet. */
  deposit(assetSymbol: string, qty: string): Promise<unknown> {
    return this.jwt(config.api.portal, 'POST', '/account/deposits', { assetSymbol, qty });
  }

  createSubaccount(label: string): Promise<SubaccountSummary> {
    return this.jwt(config.api.portal, 'POST', '/subaccounts', { label });
  }

  listSubaccounts(): Promise<SubaccountSummary[]> {
    return this.jwt(config.api.portal, 'GET', '/subaccounts');
  }

  /** move an asset master→subaccount (or sub→sub). `from`/`to` are account ids. */
  transfer(fromAccountId: string, toAccountId: string, assetSymbol: string, qty: string, market: Market = 'SPOT'): Promise<unknown> {
    return this.jwt(config.api.portal, 'POST', '/subaccounts/transfers', {
      fromAccountId,
      toAccountId,
      assetSymbol,
      market,
      qty,
    });
  }

  /** issue a trade+read API key bound to a subaccount; secret returned once. */
  issueApiKey(subaccountId: string, label: string): Promise<SubaccountCreds & { id: string }> {
    return this.jwt(config.api.portal, 'POST', `/subaccounts/${subaccountId}/api-keys`, {
      label,
      canTrade: true,
      canRead: true,
    });
  }

  subaccountBalances(subaccountId: string): Promise<{ assetSymbol: string; marketType: Market; balance: string; locked: string }[]> {
    return this.jwt(config.api.portal, 'GET', `/subaccounts/${subaccountId}/balances`);
  }
}

/**
 * One agent's authenticated handle: trades + reads as a single subaccount via HMAC
 * API-key auth (Binance-style). canonical string = `queryString(without signature) + body`,
 * HMAC-SHA256 hex. Public market data needs no signature.
 */
export class SubaccountClient {
  constructor(
    readonly label: string,
    private readonly creds: SubaccountCreds,
  ) {}

  // ---- signed request ----
  private async signed<T>(
    base: string,
    method: string,
    path: string,
    query: Record<string, string | number> = {},
    body?: unknown,
  ): Promise<T> {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) usp.set(k, String(v));
    usp.set('timestamp', String(Date.now()));
    usp.set('recvWindow', String(config.agent.recvWindowMs));
    const qs = usp.toString();
    const payload = body !== undefined ? JSON.stringify(body) : '';
    const signature = crypto.createHmac('sha256', this.creds.secret).update(qs + payload).digest('hex');

    const headers: Record<string, string> = { 'X-API-KEY': this.creds.apiKey };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const url = `${base}${path}?${qs}&signature=${signature}`;
    const { data } = await request<T>(url, method, headers, body !== undefined ? payload : undefined);
    return data;
  }

  // ---- account (signed) ----
  balances(market: Market): Promise<Balance[]> {
    const path = market === 'SPOT' ? '/spot/account/balances' : '/futures/account/balances';
    return this.signed<{ assetSymbol: string; balance: string; locked: string }[]>(apiBase(market), 'GET', path).then(
      (rows) => rows.map((r) => ({ asset: r.assetSymbol, free: r.balance, locked: r.locked })),
    );
  }

  openOrders(market: Market, symbol?: string): Promise<LocalOrder[]> {
    const path = market === 'SPOT' ? '/spot/account/open-orders' : '/futures/account/open-orders';
    return this.signed<LocalOrder[]>(apiBase(market), 'GET', path, symbol ? { symbol } : {});
  }

  trades(market: Market, opts: { symbol?: string; limit?: number; endTime?: number } = {}): Promise<AccountTrade[]> {
    const path = market === 'SPOT' ? '/spot/account/trades' : '/futures/account/trades';
    const q: Record<string, string | number> = { limit: opts.limit ?? 100 };
    if (opts.symbol) q.symbol = opts.symbol;
    if (opts.endTime !== undefined) q.endTime = opts.endTime;
    return this.signed<AccountTrade[]>(apiBase(market), 'GET', path, q);
  }

  /** portal daily net-worth snapshots for this subaccount. */
  netWorth(from?: number, to?: number): Promise<{ time: number; totalUsdt: string }[]> {
    const q: Record<string, string | number> = {};
    if (from !== undefined) q.from = from;
    if (to !== undefined) q.to = to;
    return this.signed<{ time: number; totalUsdt: string }[]>(config.api.portal, 'GET', '/account/net-worth', q);
  }

  // ---- trading (signed) ----
  /** resting GTC order. type='POST_ONLY' → maker-only (즉시 크로스면 엔진이 거절). */
  placeLimit(
    spec: SymbolSpec,
    side: Side,
    price: string,
    qty: string,
    type: 'LIMIT' | 'POST_ONLY' = 'LIMIT',
  ): Promise<LocalOrder> {
    if (spec.market === 'SPOT') {
      return this.signed<LocalOrder>(config.api.spot, 'POST', '/spot/trading/orders', {}, {
        tickerSymbol: spec.symbol,
        tickerMarket: 'SPOT',
        type,
        side,
        timeInForce: 'GTC',
        price,
        origQty: qty,
      });
    }
    return this.signed<LocalOrder>(config.api.futures, 'POST', '/futures/trading/orders', {}, {
      symbol: spec.symbol,
      type,
      side,
      timeInForce: 'GTC',
      price,
      qty,
    });
  }

  // ---- user data stream (listenKey) ----
  private listenKeyPath(market: Market): string {
    return market === 'SPOT' ? '/spot/user-data-stream' : '/futures/account/user-data-stream';
  }

  createListenKey(market: Market): Promise<string> {
    return this.signed<{ listenKey: string }>(apiBase(market), 'POST', this.listenKeyPath(market)).then(
      (d) => d.listenKey,
    );
  }

  keepaliveListenKey(market: Market, listenKey: string): Promise<unknown> {
    return this.signed(apiBase(market), 'PUT', this.listenKeyPath(market), { listenKey });
  }

  /** market taker order. SPOT BUY uses quote qty; everything else uses base qty. */
  placeMarket(spec: SymbolSpec, side: Side, baseQty: string, quoteQty: string): Promise<LocalOrder> {
    if (spec.market === 'SPOT') {
      const body =
        side === 'BUY'
          ? { tickerSymbol: spec.symbol, tickerMarket: 'SPOT', type: 'MARKET', side, timeInForce: 'IOC', origQuoteQty: quoteQty }
          : { tickerSymbol: spec.symbol, tickerMarket: 'SPOT', type: 'MARKET', side, timeInForce: 'IOC', origQty: baseQty };
      return this.signed<LocalOrder>(config.api.spot, 'POST', '/spot/trading/orders', {}, body);
    }
    return this.signed<LocalOrder>(config.api.futures, 'POST', '/futures/trading/orders', {}, {
      symbol: spec.symbol,
      type: 'MARKET',
      side,
      qty: baseQty,
    });
  }

  /** marketable limit taker (IOC): fills up to `price`, cancels the rest. Caps slippage to the
   *  limit — the right primitive for thin-margin arbitrage legs (MARKET would sweep and slip). */
  placeLimitIoc(spec: SymbolSpec, side: Side, price: string, qty: string): Promise<LocalOrder> {
    if (spec.market === 'SPOT') {
      return this.signed<LocalOrder>(config.api.spot, 'POST', '/spot/trading/orders', {}, {
        tickerSymbol: spec.symbol,
        tickerMarket: 'SPOT',
        type: 'LIMIT',
        side,
        timeInForce: 'IOC',
        price,
        origQty: qty,
      });
    }
    return this.signed<LocalOrder>(config.api.futures, 'POST', '/futures/trading/orders', {}, {
      symbol: spec.symbol,
      type: 'LIMIT',
      side,
      timeInForce: 'IOC',
      price,
      qty,
    });
  }

  cancel(market: Market, orderId: string): Promise<unknown> {
    const path = market === 'SPOT' ? `/spot/trading/orders/${orderId}` : `/futures/trading/orders/${orderId}`;
    return this.signed(apiBase(market), 'DELETE', path);
  }

  cancelAll(market: Market, symbol: string): Promise<unknown> {
    const path = market === 'SPOT' ? '/spot/trading/open-orders' : '/futures/trading/open-orders';
    return this.signed(apiBase(market), 'DELETE', path, { symbol });
  }

  setLeverage(symbol: string, leverage: number): Promise<unknown> {
    return this.signed(config.api.futures, 'PATCH', `/futures/trading/positions/${symbol}`, {}, { leverage });
  }
}

export { exchangeInfo, depth, klines };
