import type { SubaccountClient } from '../core/exchange';
import { ApiError } from '../core/exchange';
import { makeLogger, type Logger } from '../core/logger';
import { floorQty, meetsMinNotional, roundPrice, toFixedStr } from '../core/precision';
import type { Market, SymbolSpec } from '../core/types';
import type { ExecutionContext, Fill, OrderIntent, Position } from '../strategy/types';

/**
 * Live ExecutionContext: routes a strategy's intents to the local exchange as the
 * agent's subaccount (HMAC REST). Position + equity are resynced from the subaccount's
 * own balances each bar (source of truth), so a missed order response self-heals.
 */
export class LiveBroker implements ExecutionContext {
  readonly market: Market;
  readonly log: Logger;
  private pos: Position = { qty: 0, avgEntry: 0 };
  private quoteTotal: number;
  private mark = 0;
  private fillCb: ((f: Fill) => void) | null = null;
  private baseFree = 0; // free base balance, decremented as SELLs are placed within a bar
  private fillsSeeded = false;
  private seenFills = new Set<string>(); // delivered trade ids (dedup, same-ms safe)

  constructor(
    readonly spec: SymbolSpec,
    private readonly client: SubaccountClient,
    initialCapital: number,
  ) {
    this.market = spec.market;
    this.quoteTotal = initialCapital;
    this.log = makeLogger(`live:${spec.symbol}`);
  }

  onFill(cb: (f: Fill) => void): void {
    this.fillCb = cb;
  }

  position(): Position {
    return { ...this.pos };
  }
  equityUsdt(): number {
    return this.quoteTotal + this.pos.qty * this.mark;
  }
  now(): number {
    return Date.now();
  }

  /** resync quote + base balances and the current mark before each decision. Throws on
   *  a failed read so the agent surfaces a persistent auth/balance problem (not silent). */
  async refresh(mark: number): Promise<void> {
    this.mark = mark;
    const bals = await this.client.balances(this.market);
    const sum = (asset: string): number =>
      bals.filter((b) => b.asset === asset).reduce((a, b) => a + Number(b.free) + Number(b.locked), 0);
    this.quoteTotal = sum(this.spec.quoteAsset);
    const base = sum(this.spec.baseAsset);
    this.baseFree = bals.filter((b) => b.asset === this.spec.baseAsset).reduce((a, b) => a + Number(b.free), 0);
    this.pos = { qty: base, avgEntry: base > 0 ? this.pos.avgEntry : 0 };
    if (this.fillCb) await this.pollFills(); // deliver resting-limit fills (grid / market-making)
  }

  /** poll own trades and deliver newly-seen ones as onFill events, deduped by trade id
   *  (same-ms / self-trade safe). The first poll only seeds the seen-set (no history replay). */
  private async pollFills(): Promise<void> {
    const batch = await this.client.trades(this.market, { symbol: this.spec.symbol, limit: 100 });
    const fresh = batch.filter((t) => !this.seenFills.has(t.id));
    for (const t of fresh) this.seenFills.add(t.id);
    if (this.seenFills.size > 5000) this.seenFills = new Set([...this.seenFills].slice(-2000)); // keep most-recent ids
    if (!this.fillsSeeded) {
      this.fillsSeeded = true;
      return;
    }
    if (batch.length === 100 && fresh.length === 100) this.log.warn('fill page saturated — raise poll rate or some fills may be missed');
    for (const t of fresh.sort((a, b) => a.time - b.time)) {
      const price = Number(t.price);
      const commission = Number(t.commission);
      const fee = t.commissionAsset === this.spec.quoteAsset ? commission : commission * price;
      this.fillCb?.({
        orderId: t.orderId,
        side: t.isBuyer ? 'BUY' : 'SELL',
        price,
        qty: Number(t.qty),
        fee,
        feeAsset: t.commissionAsset,
        isMaker: t.isMaker,
        time: t.time,
      });
    }
  }

  async submit(intent: OrderIntent): Promise<void> {
    try {
      switch (intent.kind) {
        case 'MARKET':
          await this.market_(intent.side, intent.qty);
          break;
        case 'MARKET_QUOTE':
          await this.marketQuote(intent.side, intent.quoteQty);
          break;
        case 'LIMIT':
          await this.limit(intent.side, intent.price, intent.qty);
          break;
        case 'FLATTEN':
          if (this.pos.qty > 0) await this.market_('SELL', this.pos.qty);
          break;
        case 'CANCEL':
          await this.client.cancel(this.market, intent.orderId);
          break;
      }
    } catch (e) {
      if (!(e instanceof ApiError)) this.log.warn('submit failed', (e as Error).message);
      else this.log.warn(`submit rejected: ${e.message}`);
    }
  }

  private async market_(side: 'BUY' | 'SELL', qty: number): Promise<void> {
    if (side === 'SELL') qty = Math.min(qty, this.baseFree); // long-only: never sell more than free base
    const baseQty = floorQty(this.spec, qty);
    if (Number(baseQty) <= 0 || !meetsMinNotional(this.spec, this.mark, Number(baseQty))) return;
    const quoteQty = toFixedStr(Number(baseQty) * this.mark, this.spec.pricePrecision);
    const order = await this.client.placeMarket(this.spec, side, baseQty, quoteQty);
    if (side === 'SELL') this.baseFree -= Number(baseQty);
    this.applyOrder(side, order);
  }

  private async marketQuote(side: 'BUY' | 'SELL', quoteQty: number): Promise<void> {
    if (side === 'SELL') {
      // size from quote like the sim broker, capped to the held position (parity)
      const baseQty = Math.min(Number(floorQty(this.spec, quoteQty / (this.mark || 1))), this.pos.qty);
      return this.market_('SELL', baseQty);
    }
    const q = toFixedStr(quoteQty, this.spec.pricePrecision);
    if (Number(q) < this.spec.minNotional) return;
    const baseGuess = floorQty(this.spec, quoteQty / (this.mark || 1));
    const order = await this.client.placeMarket(this.spec, 'BUY', baseGuess, q);
    this.applyOrder('BUY', order);
  }

  private async limit(side: 'BUY' | 'SELL', price: number, qty: number): Promise<void> {
    if (side === 'SELL') qty = Math.min(qty, this.baseFree); // long-only: cap to free base inventory
    const p = roundPrice(this.spec, price);
    const baseQty = floorQty(this.spec, qty);
    if (Number(baseQty) <= 0 || !meetsMinNotional(this.spec, Number(p), Number(baseQty))) return;
    await this.client.placeLimit(this.spec, side, p, baseQty);
    if (side === 'SELL') this.baseFree -= Number(baseQty);
  }

  /** optimistically fold a market-order response into the local position so the strategy
   *  sees its fill within the same bar (the next refresh resyncs from balances). onFill is
   *  delivered separately by pollFills() to keep one fill source. */
  private applyOrder(side: 'BUY' | 'SELL', order: { executedQty?: string; cumulativeQuoteQty?: string | null }): void {
    const exec = Number(order.executedQty ?? 0);
    if (exec <= 0) return;
    const quote = Number(order.cumulativeQuoteQty ?? 0);
    const price = quote > 0 ? quote / exec : this.mark;
    if (side === 'BUY') {
      const cost = this.pos.avgEntry * this.pos.qty + price * exec;
      this.pos.qty += exec;
      this.pos.avgEntry = this.pos.qty > 0 ? cost / this.pos.qty : 0;
    } else {
      this.pos.qty = Math.max(0, this.pos.qty - exec);
      if (this.pos.qty === 0) this.pos.avgEntry = 0;
    }
  }
}
