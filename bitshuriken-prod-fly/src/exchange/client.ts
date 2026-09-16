import * as crypto from 'node:crypto';
import { config } from '../config';
import type { Bar, Side, SymbolSpec } from '../core/types';

/** bitshuriken-prod spot 클라이언트 — 일반 유저 표면만 (공개 시세 + HMAC 주문). agents/bots의 클라이언트와 같은 프로토콜의 얇은 복제. */

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

export interface Creds {
  apiKey: string;
  secret: string;
}

export interface LocalOrder {
  id: string;
  status: string;
  side?: Side;
  price: string | null;
  origQty: string | null;
  executedQty: string;
  cumulativeQuoteQty?: string;
}

export interface AccountTrade {
  id: string;
  orderId: string;
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  isBuyer: boolean;
  isMaker: boolean;
  time: number;
}

export interface Balance {
  asset: string;
  free: string;
  locked: string;
}

const MAX_RL_RETRIES = 5;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** fetch + `{code,message,data}` envelope unwrap. 멱등 호출(GET/DELETE)만 429/418 백오프 재시도. */
export async function request<T>(url: string, method: string, headers: Record<string, string>, body?: string): Promise<{ data: T; res: Response }> {
  const h = config.internalToken ? { ...headers, 'X-Internal-Token': config.internalToken } : headers;
  const retryable = method === 'GET' || method === 'DELETE';
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method, headers: h, body });
    } catch (e) {
      // 일시 네트워크 실패('fetch failed') — 멱등 호출만 짧게 재시도
      if (retryable && attempt < 2) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw e;
    }
    if ((res.status === 429 || res.status === 418) && retryable && attempt < MAX_RL_RETRIES) {
      const ra = Number(res.headers.get('Retry-After')) || 1;
      await sleep(ra * 1000 + Math.random() * 250);
      continue;
    }
    let payload: Envelope<T> | null = null;
    try {
      payload = (await res.json()) as Envelope<T>;
    } catch {
      /* non-JSON */
    }
    if (!res.ok || (payload && payload.code !== 0)) {
      const msg = payload?.message ?? `${res.status} ${res.statusText}`;
      throw new ApiError(`${method} ${url} → ${msg}`, res.status, payload?.code ?? null);
    }
    return { data: (payload as Envelope<T> | null)?.data as T, res };
  }
}

async function publicGet<T>(path: string): Promise<T> {
  const { data } = await request<T>(`${config.api.spot}${path}`, 'GET', {});
  return data;
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

export async function exchangeInfo(): Promise<SymbolSpec[]> {
  const data = await publicGet<{ symbols: ExchangeInfoSymbol[] }>('/spot/market/exchange-info');
  return data.symbols.map((s) => ({
    symbol: s.symbol,
    pricePrecision: s.pricePrecision,
    qtyPrecision: s.qtyPrecision,
    tickSize: Number(s.tickSize),
    stepSize: Number(s.stepSize),
    minNotional: Number(s.minNotional),
    baseAsset: s.baseAsset,
    quoteAsset: s.quoteAsset,
  }));
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

/** 로컬 거래소 공개 klines. oldest→newest; 마지막 bar는 미완(isFinal=false)일 수 있다. */
export async function klines(symbol: string, interval: string, limit = 500, endTime?: number): Promise<Bar[]> {
  const q = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (endTime !== undefined) q.set('endTime', String(endTime));
  const rows = await publicGet<RawKline[]>(`/spot/market/klines?${q.toString()}`);
  return rows.map((k) => ({
    openTime: k.openTime,
    open: Number(k.open),
    high: Number(k.high),
    low: Number(k.low),
    close: Number(k.close),
    volume: Number(k.volume),
    closeTime: k.closeTime,
    isFinal: k.isFinal ?? true,
  }));
}

function extractSessionToken(res: Response): string | null {
  const getter = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getter === 'function' ? getter.call(res.headers) : [];
  const raw = cookies.length ? cookies : [res.headers.get('set-cookie') ?? ''];
  for (const c of raw) if (c.startsWith('bs_session=')) return decodeURIComponent(c.slice('bs_session='.length).split(';')[0]!);
  return null;
}

/** 초파리의 서브계정을 소유하는 마스터(JWT). 관리 표면만 쓰고 거래하지 않는다. */
export class MasterClient {
  private token: string | null = null;
  userId: string | null = null;

  async ensureAccount(email: string, password: string): Promise<void> {
    try {
      await this.auth('/auth/login', email, password);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) await this.auth('/auth/signup', email, password);
      else throw e;
    }
  }

  private async auth(path: string, email: string, password: string): Promise<void> {
    const { data, res } = await request<{ id: string }>(`${config.api.portal}${path}`, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ email, password }));
    this.userId = data.id;
    this.token = extractSessionToken(res);
    if (!this.token) throw new Error(`master: no session token from ${path}`);
  }

  private async jwt<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const { data } = await request<T>(`${config.api.portal}${path}`, method, headers, payload);
    return data;
  }

  /** dev-only instant deposit into the master's SPOT wallet. */
  deposit(assetSymbol: string, qty: string): Promise<unknown> {
    return this.jwt('POST', '/account/deposits', { assetSymbol, qty });
  }
  createSubaccount(label: string): Promise<{ id: string; label: string | null }> {
    return this.jwt('POST', '/subaccounts', { label });
  }
  transfer(fromAccountId: string, toAccountId: string, assetSymbol: string, qty: string): Promise<unknown> {
    return this.jwt('POST', '/subaccounts/transfers', { fromAccountId, toAccountId, assetSymbol, market: 'SPOT', qty });
  }
  /** trade+read API key bound to a subaccount; secret returned once. */
  issueApiKey(subaccountId: string, label: string): Promise<Creds & { id: string }> {
    return this.jwt('POST', `/subaccounts/${subaccountId}/api-keys`, { label, canTrade: true, canRead: true });
  }
}

/** 서브계정 HMAC 클라이언트 (Binance 스타일: canonical = query(signature 제외) + body, HMAC-SHA256 hex). */
export class SubaccountClient {
  constructor(private readonly creds: Creds) {}

  /** 멱등 호출(GET/DELETE)은 recvWindow 만료·429에서 매번 새로 서명해 재시도한다 (BE가 느린 순간 타임스탬프가 낡는다). */
  private async signed<T>(method: string, path: string, query: Record<string, string | number> = {}, body?: unknown): Promise<T> {
    const retryable = method === 'GET' || method === 'DELETE';
    for (let attempt = 1; ; attempt++) {
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) usp.set(k, String(v));
      usp.set('timestamp', String(Date.now()));
      usp.set('recvWindow', String(config.recvWindowMs));
      const qs = usp.toString();
      const payload = body !== undefined ? JSON.stringify(body) : '';
      const signature = crypto.createHmac('sha256', this.creds.secret).update(qs + payload).digest('hex');
      const headers: Record<string, string> = { 'X-API-KEY': this.creds.apiKey };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      try {
        const { data } = await request<T>(`${config.api.spot}${path}?${qs}&signature=${signature}`, method, headers, body !== undefined ? payload : undefined);
        return data;
      } catch (e) {
        const stale = e instanceof ApiError && (e.status === 429 || e.status === 418 || /recvWindow/i.test(e.message));
        if (!retryable || !stale || attempt >= 3) throw e;
        await sleep(500 * attempt);
      }
    }
  }

  balances(): Promise<Balance[]> {
    return this.signed<{ assetSymbol: string; balance: string; locked: string }[]>('GET', '/spot/account/balances').then((rows) =>
      rows.map((r) => ({ asset: r.assetSymbol, free: r.balance, locked: r.locked })),
    );
  }

  trades(symbol: string, limit = 100): Promise<AccountTrade[]> {
    return this.signed<AccountTrade[]>('GET', '/spot/account/trades', { symbol, limit });
  }

  /** market taker order. BUY spends `quoteQty` (USDT); SELL sells `baseQty`. */
  placeMarket(spec: SymbolSpec, side: Side, baseQty: string, quoteQty: string): Promise<LocalOrder> {
    const body =
      side === 'BUY'
        ? { tickerSymbol: spec.symbol, tickerMarket: 'SPOT', type: 'MARKET', side, timeInForce: 'IOC', origQuoteQty: quoteQty }
        : { tickerSymbol: spec.symbol, tickerMarket: 'SPOT', type: 'MARKET', side, timeInForce: 'IOC', origQty: baseQty };
    return this.signed<LocalOrder>('POST', '/spot/trading/orders', {}, body);
  }

  cancelAll(symbol: string): Promise<unknown> {
    return this.signed('DELETE', '/spot/trading/open-orders', { symbol });
  }
}
