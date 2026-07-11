import type { FeedSymbol, Market } from '../types';
import { CcxtFeed } from './ccxt-feed';

/**
 * Public Upbit market-data feed via ccxt.pro. Upbit is spot-only and KRW-quoted
 * (also USDT-quoted markets, e.g. USDT/KRW). ccxt exposes watchOrderBook/watchTrades.
 */
export class UpbitFeed extends CcxtFeed {
  constructor(market: Market, initial: FeedSymbol[], levels: number) {
    if (market !== 'SPOT') throw new Error('Upbit mirrors spot only (no perps)');
    super(market, 'upbit', initial, levels);
  }

  // BTCKRW → BTC/KRW ; USDTKRW → USDT/KRW.
  protected unified(sym: FeedSymbol): string {
    return `${sym.baseAsset}/${sym.quoteAsset}`;
  }
}
