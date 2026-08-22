import { depth } from '../core/exchange';
import type { SubaccountClient } from '../core/exchange';
import { floorQty, meetsMinNotional, roundPrice } from '../core/precision';
import { makeLogger, type Logger } from '../core/logger';
import type { DepthSnapshot, LocalOrder, Side, SymbolSpec } from '../core/types';

/** One coin's two mirror books: the direct KRW market and the USDT market. The USDT↔KRW
 *  leg (USDTKRW) is shared across all coins and passed to the engine separately. */
export interface Triangle {
  coin: string;
  direct: SymbolSpec; // e.g. BTCKRW (quote KRW)
  usd: SymbolSpec; // e.g. BTCUSDT (quote USDT)
}

export interface ArbOpts {
  quotePerLegKrw: number; // target notional per arbitrage, in KRW
  edgeBufferBps: number; // fire only when the decision edge exceeds this (bps of coin price)
  takerBps: number; // this account's taker fee, charged on every leg
  pollMs: number; // book refresh cadence — the "real-time orderbook" the strategy reacts to
  mode: 'edge' | 'gross'; // edge = net-of-fee +EV only; gross = ignore fees (execution/settlement stress)
}

interface Quote {
  bid: number;
  bidQty: number;
  ask: number;
  askQty: number;
}

interface PlannedLeg {
  spec: SymbolSpec;
  side: Side;
  price: string;
  qty: string;
}

interface ArbPlan {
  coin: string;
  dir: 'A' | 'B'; // A: buy direct / sell synthetic. B: buy synthetic / sell direct.
  grossBps: number;
  netBps: number;
  price: number; // direct mid, for logging
  qtyCoin: number;
  legs: PlannedLeg[]; // fired concurrently
}

/** one coin's edge this tick — always produced (even when negative) so we measure the whole
 *  distribution; `plan` is non-null only when it is both in-the-money and fundable. */
interface Eval {
  coin: string;
  dir: 'A' | 'B';
  grossBps: number;
  netBps: number;
  plan: ArbPlan | null;
}

function top(d: DepthSnapshot): Quote | null {
  const b = d.bids[0];
  const a = d.asks[0];
  if (!b || !a) return null;
  return { bid: b[0], bidQty: b[1], ask: a[0], askQty: a[1] };
}

/**
 * Triangular arbitrage across the kimchi triangle: coin/KRW (direct) vs coin/USDT × USDT/KRW
 * (synthetic). Reads only the live order books — no candles, no indicators. When the direct and
 * synthetic prices diverge past cost, it takes all three legs at once with marketable-limit IOC
 * orders (each capped to the touch so it never sweeps deeper). Trades as an ordinary account.
 */
export class TriangleArb {
  private readonly log = makeLogger('arb');
  private stopped = false;
  private ticks = 0;
  private attempts = 0;
  private fires = 0;
  private grossKrw = 0; // indicative per-arb KRW net (settled balances are the truth)
  private bestBps = -Infinity; // best decision edge seen (net-of-fee in edge mode, gross in gross mode)

  constructor(
    private readonly client: SubaccountClient,
    private readonly fx: SymbolSpec, // USDTKRW
    private readonly triangles: Triangle[],
    private readonly opts: ArbOpts,
  ) {}

  async run(): Promise<void> {
    this.log.ok(
      `mode=${this.opts.mode} taker=${this.opts.takerBps}bps buffer=${this.opts.edgeBufferBps}bps ` +
        `size≈${this.opts.quotePerLegKrw}KRW/leg poll=${this.opts.pollMs}ms coins=${this.triangles.map((t) => t.coin).join(',')}`,
    );
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (e) {
        this.log.warn('tick failed', (e as Error).message);
      }
      await this.sleep(this.opts.pollMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  stats(): { ticks: number; attempts: number; fires: number; grossKrw: number; bestBps: number } {
    return { ticks: this.ticks, attempts: this.attempts, fires: this.fires, grossKrw: this.grossKrw, bestBps: this.bestBps };
  }

  private async tick(): Promise<void> {
    this.ticks++;
    const fxBook = await depth('SPOT', this.fx.symbol, 5);
    const fxq = top(fxBook);
    if (!fxq) return;

    // evaluate every coin against the current books; act on the single best opportunity this tick.
    const evals = (await Promise.all(this.triangles.map((t) => this.evaluate(t, fxq)))).filter((e): e is Eval => e !== null);
    if (evals.length === 0) return;
    evals.sort((a, b) => b.netBps - a.netBps);
    const best = evals[0]!;
    this.bestBps = Math.max(this.bestBps, best.netBps);

    if (this.ticks % 25 === 0) {
      this.log.info(`best ${best.coin} dir${best.dir} gross=${best.grossBps.toFixed(2)}bps net=${best.netBps.toFixed(2)}bps (bestSeen=${this.bestBps.toFixed(2)}bps, fires=${this.fires})`);
    }
    if (best.plan) await this.execute(best.plan);
  }

  /** compute both directions for one coin off the current books. Always returns the edge (for the
   *  distribution); attaches a fundable plan only when in-the-money and the touch clears min-notional. */
  private async evaluate(t: Triangle, fxq: Quote): Promise<Eval | null> {
    const [dBook, uBook] = await Promise.all([depth('SPOT', t.direct.symbol, 5), depth('SPOT', t.usd.symbol, 5)]);
    const dq = top(dBook);
    const uq = top(uBook);
    if (!dq || !uq) return null;
    const price = (dq.bid + dq.ask) / 2; // direct KRW mid, the per-coin reference

    // gross KRW edge per coin for each direction
    const synthSell = uq.bid * fxq.bid; // sell coin for USDT, sell USDT for KRW
    const synthBuy = uq.ask * fxq.ask; // buy USDT with KRW, buy coin with USDT
    const edgeA = synthSell - dq.ask; // buy direct @ ask, sell synthetic
    const edgeB = dq.bid - synthBuy; // buy synthetic, sell direct @ bid

    const fee = this.opts.takerBps / 10_000;
    // per-coin fee ≈ taker fee on each leg's KRW notional (three legs).
    const feeA = fee * (dq.ask + 2 * synthSell);
    const feeB = fee * (2 * synthBuy + dq.bid);
    const netA = edgeA - (this.opts.mode === 'edge' ? feeA : 0);
    const netB = edgeB - (this.opts.mode === 'edge' ? feeB : 0);

    const dir: 'A' | 'B' = netA >= netB ? 'A' : 'B';
    const gross = dir === 'A' ? edgeA : edgeB;
    const net = dir === 'A' ? netA : netB;
    const grossBps = (gross / price) * 10_000;
    const netBps = (net / price) * 10_000;

    const plan = netBps > this.opts.edgeBufferBps ? this.size(t, fxq, dq, uq, dir, price, grossBps, netBps) : null;
    return { coin: t.coin, dir, grossBps, netBps, plan };
  }

  /** turn a direction into three concrete legs, sized to the smallest touch across all books. */
  private size(t: Triangle, fxq: Quote, dq: Quote, uq: Quote, dir: 'A' | 'B', price: number, grossBps: number, netBps: number): ArbPlan | null {
    const coinStep = Math.max(t.direct.stepSize, t.usd.stepSize);
    const priceU = dir === 'A' ? uq.bid : uq.ask; // USDT leg price
    const fxTouchQty = dir === 'A' ? fxq.bidQty : fxq.askQty; // USDT the FX touch can absorb
    const target = this.opts.quotePerLegKrw / price;
    const coinTouch = dir === 'A' ? Math.min(dq.askQty, uq.bidQty) : Math.min(dq.bidQty, uq.askQty);
    const rawCoin = Math.min(target, coinTouch, fxTouchQty / priceU);
    const qtyCoin = Math.floor(rawCoin / coinStep + 1e-9) * coinStep;
    if (qtyCoin <= 0) return null;

    const fxQty = qtyCoin * priceU; // USDT traded on the FX leg
    const pd = roundPrice(t.direct, dir === 'A' ? dq.ask : dq.bid);
    const pu = roundPrice(t.usd, priceU);
    const pf = roundPrice(this.fx, dir === 'A' ? fxq.bid : fxq.ask);
    const qCoinDirect = floorQty(t.direct, qtyCoin);
    const qCoinUsd = floorQty(t.usd, qtyCoin);
    const qFx = floorQty(this.fx, fxQty);

    if (
      !meetsMinNotional(t.direct, Number(pd), Number(qCoinDirect)) ||
      !meetsMinNotional(t.usd, Number(pu), Number(qCoinUsd)) ||
      !meetsMinNotional(this.fx, Number(pf), Number(qFx))
    ) {
      return null;
    }

    // leg order is irrelevant (fired concurrently); grouped by direction for clarity.
    const legs: PlannedLeg[] =
      dir === 'A'
        ? [
            { spec: t.direct, side: 'BUY', price: pd, qty: qCoinDirect }, // buy coin cheap (KRW)
            { spec: t.usd, side: 'SELL', price: pu, qty: qCoinUsd }, // sell coin (USDT)
            { spec: this.fx, side: 'SELL', price: pf, qty: qFx }, // sell the USDT for KRW
          ]
        : [
            { spec: this.fx, side: 'BUY', price: pf, qty: qFx }, // buy USDT with KRW
            { spec: t.usd, side: 'BUY', price: pu, qty: qCoinUsd }, // buy coin (USDT)
            { spec: t.direct, side: 'SELL', price: pd, qty: qCoinDirect }, // sell coin dear (KRW)
          ];

    return { coin: t.coin, dir, grossBps, netBps, price, qtyCoin, legs };
  }

  private async execute(plan: ArbPlan): Promise<void> {
    this.attempts++;
    const results = await Promise.allSettled(plan.legs.map((l) => this.client.placeLimitIoc(l.spec, l.side, l.price, l.qty)));
    const orders = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
    const rejects = results.filter((r) => r.status === 'rejected').length;

    // KRW net from the order responses — leg[2] the KRW-receiving SELL, leg[0] the KRW-spending BUY.
    // Settlement is async so these are ~0 at response time; the shutdown balance delta is the real
    // PnL. Kept only as a coarse per-fire signal.
    const krwOf = (o: LocalOrder | null | undefined): number => Number(o?.cumulativeQuoteQty ?? 0);
    const netKrw = krwOf(orders[2]) - krwOf(orders[0]);
    this.grossKrw += netKrw;
    this.fires++;

    const filled = orders.map((o, i) => `${plan.legs[i]!.spec.symbol}:${Number(o?.executedQty ?? 0)}`).join(' ');
    const tag = rejects ? this.log.warn : this.log.ok;
    tag.call(this.log, `arb #${this.fires} ${plan.coin} dir${plan.dir} net=${plan.netBps.toFixed(2)}bps → grossKrw≈${netKrw.toFixed(0)} [${filled}]${rejects ? ` (${rejects} leg rejected)` : ''}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
