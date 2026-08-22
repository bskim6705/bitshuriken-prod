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
  // BE CreateTickerDto는 @IsNumberString — 숫자로 보내면 400 (2026-07-12 실측)
  minNotional?: string;
}

/**
 * Admin surface for ticker provisioning, authenticated with the service `X-Admin-Secret`
 * header (no session). Used to list tickers and flip a seeded ticker to TRADING so live
 * agents have a market. Brand-new symbols propagate restart-free (BE가 match.*.control
 * 토픽으로 ADD를 발행, 엔진이 라이브로 lane 삽입). 단 FUTURES 단독 상장은 mark price가
 * 로컬 SPOT 체결에서만 나오므로 같은 심볼의 SPOT 시장 없이는 거래 불가 (관찰 #20).
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
