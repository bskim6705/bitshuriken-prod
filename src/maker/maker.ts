import { depth } from '../core/exchange';
import type { SubaccountClient } from '../core/exchange';
import { floorQty, meetsMinNotional, roundPrice, toFixedStr } from '../core/precision';
import { makeLogger } from '../core/logger';
import type { Balance, LocalOrder, SymbolSpec } from '../core/types';

export interface MakerOpts {
  quotePerOrder: number; // resting-order notional in the symbol's quote units
  exitMarkupBps: number; // min sell markup over entry (must cover 2× maker fee to profit)
  slBps: number; // market-sell to cut the loss if mid falls this far below entry
  pollMs: number;
  makerBps: number;
}

interface Book {
  bid: number;
  ask: number;
}

// Long-only spread-capture maker: rest a BUY at the touch; once filled, rest a SELL a fee-covering
// markup above entry to bank the spread; cut the loss with a market SELL if the mid falls too far.
// Profitable only where the captured spread exceeds the round-trip maker fee — i.e. the wide-tick
// KRW books, not the tight USDT books. Position is read from balances (async settlement).
interface State {
  entry: number; // attributed entry once inventory appears (= last resting buy price)
  lastBuyPx: number; // price of the current resting buy
}

export class SpreadMaker {
  private readonly log = makeLogger('maker');
  private stopped = false;
  private ticks = 0;
  private readonly st = new Map<string, State>();
  private roundTrips = 0; // completed buy→sell spread captures
  private stops = 0;

  constructor(
    private readonly client: SubaccountClient,
    private readonly specs: SymbolSpec[],
    private readonly opts: MakerOpts,
  ) {}

  async run(): Promise<void> {
    this.log.ok(
      `spread-capture: size≈${this.opts.quotePerOrder}/order markup=${this.opts.exitMarkupBps}bps sl=${this.opts.slBps}bps ` +
        `makerFee=${this.opts.makerBps}bps poll=${this.opts.pollMs}ms symbols=${this.specs.map((s) => s.symbol).join(',')}`,
    );
    while (!this.stopped) {
      try {
        const held = await this.baseAmounts();
        await Promise.all(this.specs.map((s) => this.quote(s, held.get(s.baseAsset) ?? 0)));
      } catch (e) {
        this.log.warn('tick failed', (e as Error).message);
      }
      this.ticks++;
      await this.sleep(this.opts.pollMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  stats(): { ticks: number; roundTrips: number; stops: number } {
    return { ticks: this.ticks, roundTrips: this.roundTrips, stops: this.stops };
  }

  private async baseAmounts(): Promise<Map<string, number>> {
    const bals: Balance[] = await this.client.balances('SPOT');
    const m = new Map<string, number>();
    for (const b of bals) m.set(b.asset, (m.get(b.asset) ?? 0) + Number(b.free) + Number(b.locked));
    return m;
  }

  private state(sym: string): State {
    let s = this.st.get(sym);
    if (!s) {
      s = { entry: 0, lastBuyPx: 0 };
      this.st.set(sym, s);
    }
    return s;
  }

  private async quote(spec: SymbolSpec, inv: number): Promise<void> {
    const d = await depth('SPOT', spec.symbol, 1);
    const b = d.bids[0];
    const a = d.asks[0];
    if (!b || !a) return;
    const book: Book = { bid: b[0], ask: a[0] };
    const s = this.state(spec.symbol);
    const dust = spec.stepSize;
    const orders = await this.client.openOrders('SPOT', spec.symbol);
    const buys = orders.filter((o) => o.side === 'BUY');
    const sells = orders.filter((o) => o.side === 'SELL');

    if (inv <= dust) {
      // FLAT — rest one BUY at the touch; a set entry here means a SELL just completed a round trip.
      if (s.entry) {
        this.roundTrips++;
        s.entry = 0;
      }
      for (const o of sells) await this.cancel(o);
      const target = roundPrice(spec, book.bid);
      await this.reprice(spec, buys, 'BUY', target, floorQty(spec, this.opts.quotePerOrder / book.bid));
      if (buys[0]) s.lastBuyPx = Number(buys[0].price ?? target);
      else s.lastBuyPx = Number(target);
      return;
    }

    // LONG — inventory to unwind.
    if (!s.entry) s.entry = s.lastBuyPx || book.bid; // attribute entry from the buy that just filled

    if (book.bid <= s.entry * (1 - this.opts.slBps / 10_000)) {
      // stop-loss: cancel everything and market out.
      for (const o of orders) await this.cancel(o);
      const q = floorQty(spec, inv);
      if (Number(q) > 0) {
        await this.client.placeMarket(spec, 'SELL', q, toFixedStr(Number(q) * book.bid, spec.pricePrecision)).catch(() => null);
        this.stops++;
        this.log.warn(`${spec.symbol} STOP mid≤entry−${this.opts.slBps}bps → market sell ${q}@~${book.bid}`);
      }
      s.entry = 0;
      return;
    }

    for (const o of buys) await this.cancel(o); // cap to one unit — no averaging down
    const floorPx = s.entry * (1 + this.opts.exitMarkupBps / 10_000);
    const target = toFixedStr(Math.max(book.ask, this.ceilTick(spec, floorPx)), spec.pricePrecision);
    await this.reprice(spec, sells, 'SELL', target, floorQty(spec, inv));
  }

  /** keep exactly one resting order of `side` at `target`; cancel+replace only when the price moved. */
  private async reprice(spec: SymbolSpec, existing: LocalOrder[], side: 'BUY' | 'SELL', target: string, qty: string): Promise<void> {
    if (Number(qty) <= 0 || !meetsMinNotional(spec, Number(target), Number(qty))) {
      for (const o of existing) await this.cancel(o);
      return;
    }
    const good = existing.find((o) => o.price === target);
    for (const o of existing) if (o !== good) await this.cancel(o);
    if (!good) await this.client.placeLimit(spec, side, target, qty).catch((e) => this.log.warn(`${spec.symbol} ${side} rejected`, (e as Error).message));
  }

  private ceilTick(spec: SymbolSpec, price: number): number {
    return Math.ceil(price / spec.tickSize - 1e-9) * spec.tickSize;
  }

  private async cancel(o: LocalOrder): Promise<void> {
    await this.client.cancel('SPOT', o.id).catch(() => {});
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
