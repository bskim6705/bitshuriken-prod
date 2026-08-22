import type { FeedSymbol, Market } from '../types';
import { CcxtFeed } from './ccxt-feed';

/**
 * Public Binance market-data feed via ccxt.pro. Spot uses `binance`, USDⓈ-M perps use
 * `binanceusdm` (ccxt unifies the spot @aggTrade vs USDⓈ-M @trade difference).
 */
export class BinanceFeed extends CcxtFeed {
  constructor(market: Market, initial: FeedSymbol[], levels: number) {
    super(market, market === 'SPOT' ? 'binance' : 'binanceusdm', initial, levels);
  }

  // BTC/USDT (spot) or BTC/USDT:USDT (perp).
  protected unified(sym: FeedSymbol): string {
    const base = `${sym.baseAsset}/${sym.quoteAsset}`;
    return this.market === 'SPOT' ? base : `${base}:${sym.quoteAsset}`;
  }
}
