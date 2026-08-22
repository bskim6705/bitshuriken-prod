import type { SubaccountClient } from '../core/exchange';
import type { Market } from '../core/types';
import { computeMetrics, barsPerYear } from './compute';
import type { EquityPoint, LedgerFill, Metrics } from './types';

export interface LiveMetricsOpts {
  market: Market;
  symbol: string;
  quoteAsset: string;
  initialCapital: number;
  interval: string;
  /** equity samples taken by the daemon (mark-to-market over time). */
  equityCurve: EquityPoint[];
}

/**
 * Live metrics for one subaccount: realized PnL / fees / win-rate from its own
 * `/account/trades`, combined with the daemon-sampled equity curve. The subaccount's
 * own API key is the ground truth — all data is isolated by its userId.
 */
export async function computeLiveMetrics(client: SubaccountClient, opts: LiveMetricsOpts): Promise<Metrics> {
  const raw = await client.trades(opts.market, { symbol: opts.symbol, limit: 1000 });
  const fills: LedgerFill[] = raw
    .map((t) => {
      const price = Number(t.price);
      const commission = Number(t.commission);
      const fee = t.commissionAsset === opts.quoteAsset ? commission : commission * price;
      return { time: t.time, side: (t.isBuyer ? 'BUY' : 'SELL') as LedgerFill['side'], price, qty: Number(t.qty), fee };
    })
    .sort((a, b) => a.time - b.time); // chronological for avg-cost accounting

  return computeMetrics({
    initialCapital: opts.initialCapital,
    fills,
    equityCurve: opts.equityCurve,
    barsPerYear: barsPerYear(opts.interval),
  });
}
