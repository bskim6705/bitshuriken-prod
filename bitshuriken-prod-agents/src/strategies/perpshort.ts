import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { atr } from '../indicators/atr';
import { floorQty, meetsMinNotional } from '../core/precision';

interface P {
  lookbackBars: number;
  threshAtrMults: number;
  atrLen: number;
  tpAtrMult: number;
  slAtrMult: number;
  maxBars: number;
  capitalFrac: number;
  leverage: number;
}

type State = 'flat' | 'pendingOpen' | 'short' | 'pendingClose';

/**
 * Momentum SHORT on FUTURES: sell a fresh down-thrust closing weak, cover on an
 * ATR-scaled take-profit / stop-loss or a time stop. One position at a time.
 *
 * The sim + live brokers model position/equity from a SPOT base-asset balance, which
 * cannot represent a short (a perp holds USDT margin, not base). So this strategy keeps
 * its OWN signed position + realized PnL from onFill (fills carry true price/qty/fee) and
 * does not trust ctx.position()/equityUsdt() beyond the flat-at-init capital snapshot.
 * `leverage` is consumed by the supervisor (setLeverage at agent start); sim ignores it.
 */
class PerpShort implements Strategy {
  readonly id = 'perpshort';
  private ctx!: ExecutionContext;
  private p: P = { lookbackBars: 5, threshAtrMults: 1, atrLen: 14, tpAtrMult: 2, slAtrMult: 1.5, maxBars: 30, capitalFrac: 0.5, leverage: 2 };
  private bars: Bar[] = [];
  private state: State = 'flat';
  private entryPrice = 0;
  private entryFee = 0;
  private shortQty = 0;
  private barsHeld = 0;
  private capital0 = 0;
  private realized = 0;
  private entries = 0;
  private closes = 0;
  private wins = 0;
  private seen = 0; // bars decided after warmup (for firing-rate reporting)

  get warmupBars(): number {
    return Math.max(this.p.atrLen, this.p.lookbackBars) + 5;
  }

  init(ctx: ExecutionContext, params: StrategyParams): void {
    this.ctx = ctx;
    this.applyParams(params);
    this.capital0 = ctx.equityUsdt(); // flat at init → true starting capital (both brokers)
  }

  applyParams(params: StrategyParams): void {
    for (const k of Object.keys(this.p) as (keyof P)[]) {
      const v = params[k];
      if (typeof v === 'number') this.p[k] = v;
    }
  }

  warmup(bars: Bar[]): void {
    for (const b of bars) this.bars.push(b);
  }

  onBar(bar: Bar): void {
    this.bars.push(bar);
    if (this.bars.length > 400) this.bars.shift();
    if (this.bars.length < Math.max(this.p.atrLen, this.p.lookbackBars) + 1) return;
    this.seen++;

    const atrPct = atr(this.bars.slice(-(this.p.atrLen + 1)), this.p.atrLen) / bar.close;
    if (this.state === 'short') return this.manageExit(bar, atrPct);
    if (this.state !== 'flat') return; // a fill is in flight — hold until onFill resolves it

    const past = this.bars[this.bars.length - 1 - this.p.lookbackBars];
    if (!past || atrPct <= 0) return;
    const ret = (bar.close - past.close) / past.close;
    const range = bar.high - bar.low;
    const bottomThird = range <= 0 || bar.close <= bar.low + range / 3;
    if (ret < -this.p.threshAtrMults * atrPct && bottomThird) {
      const equity = this.capital0 + this.realized;
      const qty = Number(floorQty(this.ctx.spec, (this.p.capitalFrac * equity) / bar.close));
      if (qty > 0 && meetsMinNotional(this.ctx.spec, bar.close, qty)) {
        this.state = 'pendingOpen';
        void this.ctx.submit({ kind: 'MARKET', side: 'SELL', qty }); // open short
      }
    }
  }

  private manageExit(bar: Bar, atrPct: number): void {
    this.barsHeld++;
    const pnlPct = (this.entryPrice - bar.close) / this.entryPrice; // + when price fell = short profit
    const hitTp = pnlPct >= this.p.tpAtrMult * atrPct;
    const hitSl = pnlPct <= -this.p.slAtrMult * atrPct;
    if (hitTp || hitSl || this.barsHeld >= this.p.maxBars) {
      this.state = 'pendingClose';
      void this.ctx.submit({ kind: 'MARKET', side: 'BUY', qty: this.shortQty }); // cover (flatten)
    }
  }

  onFill(f: Fill): void {
    if (f.side === 'SELL') {
      this.entryPrice = f.price;
      this.shortQty = f.qty;
      this.entryFee = f.fee;
      this.barsHeld = 0;
      this.state = 'short';
      this.entries++;
    } else {
      const pnl = (this.entryPrice - f.price) * this.shortQty - this.entryFee - f.fee;
      this.realized += pnl;
      this.closes++;
      if (pnl > 0) this.wins++;
      this.shortQty = 0;
      this.state = 'flat';
    }
    const netPct = this.capital0 > 0 ? (this.realized / this.capital0) * 100 : 0;
    this.ctx.log.ok(
      `PERPSHORT ${this.ctx.spec.symbol} ${f.side === 'SELL' ? 'open' : 'cover'} entries=${this.entries} closes=${this.closes} wins=${this.wins} netUsdt=${this.realized.toFixed(2)} netPct=${netPct.toFixed(3)} seen=${this.seen}`,
    );
  }
}

const factory: StrategyFactory = {
  id: 'perpshort',
  paramSchema: {
    lookbackBars: { type: 'number', default: 5, min: 1, max: 100, desc: 'return lookback (bars)' },
    threshAtrMults: { type: 'number', default: 1, min: 0.1, max: 10, desc: 'entry when return < -mult×ATR%' },
    atrLen: { type: 'number', default: 14, min: 2, max: 200, desc: 'ATR length (bars)' },
    tpAtrMult: { type: 'number', default: 2, min: 0.1, max: 20, desc: 'take-profit at mult×ATR% favorable' },
    slAtrMult: { type: 'number', default: 1.5, min: 0.1, max: 20, desc: 'stop-loss at mult×ATR% adverse' },
    maxBars: { type: 'number', default: 30, min: 1, max: 500, desc: 'time stop (bars held)' },
    capitalFrac: { type: 'number', default: 0.5, min: 0.01, max: 1, desc: 'short notional = frac×capital' },
    leverage: { type: 'number', default: 2, min: 1, max: 125, desc: 'futures leverage (set at agent start)' },
  },
  create: () => new PerpShort(),
};

export default factory;
