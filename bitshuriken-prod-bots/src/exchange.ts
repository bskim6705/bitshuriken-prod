import crypto from 'node:crypto';
import { config, apiBase } from './config';
import type { Balance, DepthSnapshot, LocalOrder, Market, Side, SymbolSpec } from './types';

const MAX_RL_RETRIES = 5;
const RECV_WINDOW_MS = 30_000; // long-running bot: generous clock-skew tolerance (guard caps at 60s)
// 무타임아웃 fetch는 BE 재시작 순단에 영구 행잉 → 봇 루프 침묵 웨지 (2026-07-14 실측).
// 타임아웃으로 요청을 실패시켜 기존 에러 경로(로그+다음 루프)로 회복시킨다.
const REQ_TIMEOUT_MS = 10_000;
const rlSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class ApiError extends Error {
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

export interface ApiKeyPair {
  apiKey: string;
  secret: string;
}

/** HMAC-SHA256(queryString_without_signature + body, secret) hex — matches ApiKeyOnlyGuard. */
function sign(secret: string, queryString: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(queryString + body).digest('hex');
}

/**
 * One bot identity against the local exchange.
 *
 * Bots are ordinary users (feedback-025): every trade/account/funding call is an HMAC-signed
 * API-key request, exactly like a real API client. A JWT session (from signup/login) is kept
 * only to bootstrap the API key and to call the operator surface (subaccounts/admin) that the
 * key scope intentionally cannot reach.
 */
export class LocalExchangeClient {
  private cookie: string | null = null;
  private key: ApiKeyPair | null = null;
  userId: string | null = null;

  constructor(readonly label: string) {}

  // ---- low-level: public / cookie ----
  private async raw<T>(
    base: string,
    method: string,
    path: string,
    opts: { body?: unknown; cookie?: boolean } = {},
  ): Promise<{ data: T; res: Response }> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.cookie && this.cookie) headers['Cookie'] = this.cookie;
    const retryable = method === 'GET' || method === 'DELETE';
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      if ((res.status === 429 || res.status === 418) && retryable && attempt < MAX_RL_RETRIES) {
        const ra = Number(res.headers.get('Retry-After')) || 1;
        await rlSleep(ra * 1000 + Math.random() * 250);
        continue;
      }
      return unwrap<T>(method, path, res);
    }
  }

  // ---- low-level: HMAC-signed API-key request ----
  private async signed<T>(
    base: string,
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    if (!this.key) throw new Error(`${this.label}: API key not initialized (call ensureApiKey)`);
    const bodyStr = opts.body === undefined ? '' : JSON.stringify(opts.body);
    const qs = new URLSearchParams({
      ...(opts.query ?? {}),
      timestamp: String(Date.now()),
      recvWindow: String(RECV_WINDOW_MS),
    }).toString();
    const signature = sign(this.key.secret, qs, bodyStr);
    const headers: Record<string, string> = { 'X-API-KEY': this.key.apiKey };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const retryable = method === 'GET' || method === 'DELETE';
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${path}?${qs}&signature=${signature}`, {
        method,
        headers,
        body: opts.body !== undefined ? bodyStr : undefined,
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      if ((res.status === 429 || res.status === 418) && retryable && attempt < MAX_RL_RETRIES) {
        const ra = Number(res.headers.get('Retry-After')) || 1;
        await rlSleep(ra * 1000 + Math.random() * 250);
        continue;
      }
      const { data } = await unwrap<T>(method, path, res);
      return data;
    }
  }

  // ---- bootstrap ----
  /** login if the account exists, else signup; store the JWT session cookie. */
  async ensureAccount(email: string, password: string): Promise<void> {
    try {
      await this.authRequest('/auth/login', email, password);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
        await this.authRequest('/auth/signup', email, password);
      } else {
        throw e;
      }
    }
  }

  private async authRequest(path: string, email: string, password: string): Promise<void> {
    const { data, res } = await this.raw<{ id: string }>(config.api.portal, 'POST', path, {
      body: { email, password },
    });
    this.userId = data.id;
    this.cookie = extractSessionCookie(res);
    if (!this.cookie) throw new Error(`${this.label}: no session cookie from ${path}`);
  }

  /**
   * Create a trading API key via the JWT session; store the HMAC pair. The portal mints a new
   * key on every call, so callers should try a persisted pair first (setApiKey + keyWorks) and
   * only fall back here — otherwise every boot grows the account's key list.
   */
  async ensureApiKey(): Promise<void> {
    const data = await this.raw<ApiKeyPair>(config.api.portal, 'POST', '/auth/api-keys', {
      cookie: true,
      body: { label: `${this.label}-bot`, canTrade: true, canRead: true },
    });
    this.key = { apiKey: data.data.apiKey, secret: data.data.secret };
  }

  /** install a previously persisted HMAC pair (validate with keyWorks before trusting it). */
  setApiKey(pair: ApiKeyPair): void {
    this.key = pair;
  }

  getApiKey(): ApiKeyPair | null {
    return this.key;
  }

  /** probe the installed key with a signed read; false on an auth rejection (revoked/unknown). */
  async keyWorks(): Promise<boolean> {
    try {
      await this.balances('SPOT');
      return true;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return false;
      throw e; // network/backend trouble is not a verdict on the key
    }
  }

  /**
   * Flag this account rate-limit exempt via the operator surface (X-Admin-Secret). This is an
   * operator action, not a trade — market-making accounts run without limits (ADR-066).
   */
  async ensureRateLimitExempt(adminSecret: string): Promise<void> {
    if (!this.userId) throw new Error(`${this.label}: no userId`);
    const res = await fetch(
      `${config.api.portal}/admin/users/${this.userId}/rate-limit-exempt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': adminSecret },
        body: JSON.stringify({ exempt: true }),
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      },
    );
    await unwrap<unknown>('POST', '/admin/users/:id/rate-limit-exempt', res);
  }

  // ---- funding (TRADE scope) ----
  deposit(assetSymbol: string, qty: string): Promise<unknown> {
    return this.signed(config.api.portal, 'POST', '/account/deposits', { body: { assetSymbol, qty } });
  }

  transfer(from: Market, to: Market, assetSymbol: string, qty: string): Promise<unknown> {
    return this.signed(config.api.portal, 'POST', '/account/transfers', {
      body: { fromMarket: from, toMarket: to, assetSymbol, qty },
    });
  }

  // ---- market data (public) ----
  async exchangeInfo(market: Market): Promise<SymbolSpec[]> {
    const path = market === 'SPOT' ? '/spot/market/exchange-info' : '/futures/market/exchange-info';
    const { data } = await this.raw<{ symbols: ExchangeInfoSymbol[] }>(apiBase(market), 'GET', path);
    return data.symbols.map((s) => ({
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
  }

  async depth(market: Market, symbol: string, limit = 50): Promise<DepthSnapshot> {
    const path = market === 'SPOT' ? '/spot/market/depth' : '/futures/market/depth';
    const { data } = await this.raw<{
      lastUpdateId: number;
      bids: [string, string][];
      asks: [string, string][];
    }>(apiBase(market), 'GET', `${path}?symbol=${symbol}&limit=${limit}`);
    const map = (l: [string, string][]): [number, number][] =>
      l.map(([p, q]) => [Number(p), Number(q)]);
    return { bids: map(data.bids), asks: map(data.asks), lastUpdateId: data.lastUpdateId };
  }

  // ---- account (READ scope) ----
  balances(market: Market): Promise<Balance[]> {
    const path = market === 'SPOT' ? '/spot/account/balances' : '/futures/account/balances';
    return this.signed<Balance[]>(apiBase(market), 'GET', path);
  }

  openOrders(market: Market, symbol: string): Promise<LocalOrder[]> {
    const path = market === 'SPOT' ? '/spot/account/open-orders' : '/futures/account/open-orders';
    return this.signed<LocalOrder[]>(apiBase(market), 'GET', path, { query: { symbol } });
  }

  positions(symbol: string): Promise<{ symbol: string; qty: string; markPrice: string | null }[]> {
    return this.signed(config.api.futures, 'GET', '/futures/account/positions', { query: { symbol } });
  }

  // ---- user data stream (READ scope) ----
  private listenKeyPath(market: Market): string {
    return market === 'SPOT' ? '/spot/user-data-stream' : '/futures/account/user-data-stream';
  }

  createListenKey(market: Market): Promise<string> {
    return this.signed<{ listenKey: string }>(
      apiBase(market),
      'POST',
      this.listenKeyPath(market),
    ).then((d) => d.listenKey);
  }

  keepaliveListenKey(market: Market, listenKey: string): Promise<unknown> {
    return this.signed(apiBase(market), 'PUT', this.listenKeyPath(market), { query: { listenKey } });
  }

  // ---- trading (TRADE scope) ----
  placeLimit(spec: SymbolSpec, side: Side, price: string, qty: string): Promise<LocalOrder> {
    return this.placeResting(spec, 'LIMIT', side, price, qty);
  }

  /**
   * maker-only resting order: the engine rejects it instead of matching if it would cross.
   * `reduceOnly` (futures only) marks a position-reducing quote — exempt from the maxNotional
   * cap, so a maker pinned at the cap can still quote its reducing side.
   */
  placePostOnly(
    spec: SymbolSpec,
    side: Side,
    price: string,
    qty: string,
    reduceOnly = false,
  ): Promise<LocalOrder> {
    return this.placeResting(spec, 'POST_ONLY', side, price, qty, reduceOnly);
  }

  private placeResting(
    spec: SymbolSpec,
    type: 'LIMIT' | 'POST_ONLY',
    side: Side,
    price: string,
    qty: string,
    reduceOnly = false,
  ): Promise<LocalOrder> {
    if (spec.market === 'SPOT') {
      return this.signed<LocalOrder>(config.api.spot, 'POST', '/spot/trading/orders', {
        body: {
          tickerSymbol: spec.symbol,
          tickerMarket: 'SPOT',
          type,
          side,
          timeInForce: 'GTC',
          price,
          origQty: qty,
        },
      });
    }
    return this.signed<LocalOrder>(config.api.futures, 'POST', '/futures/trading/orders', {
      body: { symbol: spec.symbol, type, side, timeInForce: 'GTC', price, qty, ...(reduceOnly ? { reduceOnly: true } : {}) },
    });
  }

  /** market taker order. SPOT BUY uses quote qty; everything else uses base qty. */
  placeMarket(spec: SymbolSpec, side: Side, baseQty: string, quoteQty: string): Promise<LocalOrder> {
    if (spec.market === 'SPOT') {
      const body =
        side === 'BUY'
          ? { tickerSymbol: spec.symbol, tickerMarket: 'SPOT', type: 'MARKET', side, timeInForce: 'IOC', origQuoteQty: quoteQty }
          : { tickerSymbol: spec.symbol, tickerMarket: 'SPOT', type: 'MARKET', side, timeInForce: 'IOC', origQty: baseQty };
      return this.signed<LocalOrder>(config.api.spot, 'POST', '/spot/trading/orders', { body });
    }
    return this.signed<LocalOrder>(config.api.futures, 'POST', '/futures/trading/orders', {
      body: { symbol: spec.symbol, type: 'MARKET', side, qty: baseQty },
    });
  }

  /**
   * Marketable-limit taker: a LIMIT IOC at `price`. Fills only what crosses at/inside `price`
   * (bids ≥ price on a SELL, asks ≤ price on a BUY) and expires the rest — so it cannot walk the
   * book past `price`. Used to replay source trades without a MARKET order sweeping thin depth.
   */
  placeLimitIoc(spec: SymbolSpec, side: Side, price: string, qty: string): Promise<LocalOrder> {
    if (spec.market === 'SPOT') {
      return this.signed<LocalOrder>(config.api.spot, 'POST', '/spot/trading/orders', {
        body: {
          tickerSymbol: spec.symbol,
          tickerMarket: 'SPOT',
          type: 'LIMIT',
          side,
          timeInForce: 'IOC',
          price,
          origQty: qty,
        },
      });
    }
    return this.signed<LocalOrder>(config.api.futures, 'POST', '/futures/trading/orders', {
      body: { symbol: spec.symbol, type: 'LIMIT', side, timeInForce: 'IOC', price, qty },
    });
  }

  /**
   * Futures inventory flatten: reduceOnly LIMIT IOC. Exempt from the maxNotional cap (it only
   * shrinks exposure), fills against whatever rests at/inside `price`, expires the rest.
   */
  placeReduceOnlyIoc(symbol: string, side: Side, price: string, qty: string): Promise<LocalOrder> {
    return this.signed<LocalOrder>(config.api.futures, 'POST', '/futures/trading/orders', {
      body: { symbol, type: 'LIMIT', side, timeInForce: 'IOC', price, qty, reduceOnly: true },
    });
  }

  cancel(market: Market, orderId: string): Promise<unknown> {
    const path =
      market === 'SPOT' ? `/spot/trading/orders/${orderId}` : `/futures/trading/orders/${orderId}`;
    return this.signed(apiBase(market), 'DELETE', path);
  }

  cancelAllSpot(symbol: string): Promise<unknown> {
    return this.signed(config.api.spot, 'DELETE', '/spot/trading/open-orders', { query: { symbol } });
  }

  setLeverage(symbol: string, leverage: number): Promise<unknown> {
    return this.signed(config.api.futures, 'PATCH', `/futures/trading/positions/${symbol}`, {
      body: { leverage },
    });
  }
}

async function unwrap<T>(
  method: string,
  path: string,
  res: Response,
): Promise<{ data: T; res: Response }> {
  let payload: Envelope<T> | null = null;
  try {
    payload = (await res.json()) as Envelope<T>;
  } catch {
    /* non-JSON */
  }
  if (!res.ok || (payload && payload.code !== 0)) {
    const msg = payload?.message ?? `${res.status} ${res.statusText}`;
    throw new ApiError(`${method} ${path} → ${msg}`, res.status, payload?.code ?? null);
  }
  return { data: (payload as Envelope<T>).data, res };
}

/** pull the bs_session JWT cookie out of a login/signup response's Set-Cookie. */
function extractSessionCookie(res: Response): string | null {
  const getter = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getter === 'function' ? getter.call(res.headers) : [];
  const raw = cookies.length ? cookies : [res.headers.get('set-cookie') ?? ''];
  for (const c of raw) {
    if (c.startsWith('bs_session=')) return c.split(';')[0]!;
  }
  return null;
}

export { ApiError };
