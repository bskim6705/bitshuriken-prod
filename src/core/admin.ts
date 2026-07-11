import { config } from '../config';
import { request } from './exchange';
import type { Market } from './types';

export type TickerStatus = 'PENDING' | 'TRADING' | 'HALTED' | 'DELISTED';

export interface Ticker {
  symbol: string;
  marketType: Market;
  baseAsset: string;
  quoteAsset: string;
  status: TickerStatus;
  pricePrecision: number;
  qtyPrecision: number;
  minNotional: string;
  partition: number;
}

export interface CreateTickerInput {
  market: Market;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  qtyPrecision: number;
  symbol?: string;
  minNotional?: number;
}

/**
 * Admin surface for ticker provisioning, authenticated with the service `X-Admin-Secret`
 * header (no session). Used to list tickers and flip a seeded ticker to TRADING so live
 * agents have a market. Creating a brand-new symbol needs a match-engine restart.
 */
export class AdminClient {
  constructor(private readonly secret: string = config.adminSecret) {}

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.secret) throw new Error('ADMIN_API_SECRET not set — cannot provision tickers');
    const headers: Record<string, string> = { 'X-Admin-Secret': this.secret };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    return request<T>(`${config.api.portal}${path}`, method, headers, payload).then((r) => r.data);
  }

  listTickers(): Promise<Ticker[]> {
    return this.call<Ticker[]>('GET', '/admin/tickers');
  }

  createTicker(input: CreateTickerInput): Promise<Ticker & { nextSteps?: string[] }> {
    return this.call('POST', '/admin/tickers', input);
  }

  setTickerStatus(market: Market, symbol: string, status: TickerStatus): Promise<unknown> {
    return this.call('PATCH', `/admin/tickers/${market.toLowerCase()}/${symbol}/status`, { status });
  }
}
