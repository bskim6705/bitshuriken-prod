import type { Bar, ExecutionContext, Fill, Strategy, StrategyFactory, StrategyParams } from '../strategy/types';
import { fixedFractionQty } from '../strategy/sizing';
import { atr } from '../indicators/atr';

const WARMUP = 360; // seed the default overnight-return lookback before the first signal
const PENDING_TIMEOUT = 4; // bars to wait on a submitted exit before retrying it

interface P {
  startH: number; // KST window start hour, inclusive
  endH: number; // KST window end hour, exclusive
  overnightBars: number; // lookback for the overnight-drop arm
  overnightDropPct: number; // arm when the return over overnightBars ≤ −this (fraction, 0.02 = 2%)
  atrLen: number; // bars of 1m ATR
  kAtr: number; // entry bid depth below price, in units of ATR%
  mAtr: number; // take-profit above entry, in units of ATR%
  maxBars: number; // time-stop: flatten after this many held bars
  entryFrac: number; // equity fraction per entry (quote)
}

/**
 * Asia-morning mean reversion (spot, long-only). Only arms inside the KST window [startH,endH)
 * (default 9–12, derived from each bar's UTC time) and only after an overnight flush — the return
 * over the last overnightBars bars ≤ −overnightDropPct. It then rests one passive dip bid at
 * −kAtr×ATR% below price (the mean-reversion entry) and brackets the fill: take-profit at
 * +mAtr×ATR% above entry, time-stop after maxBars held. Re-arms after each exit while the window
 * is open; entry LIMIT can also fill later if price finally reaches it, and is managed the same way.
 *
 * Exits are MARKET (FLATTEN), managed in onBar off the broker's position()/avgEntry — not a resting
 * TP. This framework can't cancel a resting order, so a resting TP plus a market time-stop would
 * leave a stale sell after every stop; a monitored level + single market exit keeps at most one
 * resting order (the entry bid) and never a stale one. ATR% is frozen at arm time so the bid and its
 * bracket share one volatility snapshot. onBar-driven off position() → survives restarts/partials.
 */
class MorningMean implements Strategy {
  readonly id = 'morningmean';
  readonly warmupBars = WARMUP;
  private ctx!: ExecutionContext;
  private p: P = { startH: 9, endH: 12, overnightBars: 360, overnightDropPct: 0.02, atrLen: 14, kAtr: 1.5, mAtr: 2, maxBars: 90, entryFrac: 0.5 };
  private bars: Bar[] = []; // rolling buffer (≤ overnightBars+1) for the return and ATR
  private armAtrPct = 0; // ATR% frozen when the bid was armed; sizes the take-profit
  private bidResting = false; // an entry bid is resting (awaiting fill) — don't stack another
  private barsHeld = 0; // bars since the long was observed open (time-stop clock)
  private exitSubmitted = false; // a FLATTEN is in flight
  private exitBars = 0; // bars a submitted exit has been pending

  init(ctx: ExecutionContext, params: StrategyParams): void {
    this.ctx = ctx;
    this.applyParams(params);
  }

  applyParams(params: StrategyParams): void {
    for (const k of Object.keys(this.p) as (keyof P)[]) {
      const v = params[k];
      if (typeof v === 'number') this.p[k] = v;
    }
  }

  warmup(bars: Bar[]): void {
    this.bars = bars.slice(-(this.p.overnightBars + 1));
  }

  private pushBar(b: Bar): void {
    this.bars.push(b);
    while (this.bars.length > this.p.overnightBars + 1) this.bars.shift();
  }

  private inWindow(openTime: number): boolean {
    const kstHour = (Math.floor(openTime / 3_600_000) + 9) % 24; // epoch-ms → UTC hour → KST
    return kstHour >= this.p.startH && kstHour < this.p.endH;
  }

  onBar(bar: Bar): void {
    this.pushBar(bar);
    const pos = this.ctx.position();
    const isLong = pos.qty * bar.close >= this.ctx.spec.minNotional; // dust below min-notional = flat

    if (isLong) {
      this.bidResting = false; // the bid filled → now bracketing the position
      this.barsHeld++;
      if (!this.exitSubmitted) {
        const tp = pos.avgEntry * (1 + this.p.mAtr * this.armAtrPct);
        if (bar.high >= tp || this.barsHeld >= this.p.maxBars) {
          void this.ctx.submit({ kind: 'FLATTEN' }); // TP touched or time-stop → market exit
          this.exitSubmitted = true;
          this.exitBars = 0;
        }
      } else if (++this.exitBars > PENDING_TIMEOUT) {
        void this.ctx.submit({ kind: 'FLATTEN' }); // exit didn't take — retry
        this.exitBars = 0;
      }
      return;
    }

    // flat
    this.barsHeld = 0;
    this.exitSubmitted = false;
    if (this.bidResting) return; // a bid already rests; can't cancel, so never stack a second
    if (!this.inWindow(bar.openTime)) return;
    const atrPct = atr(this.bars.slice(-(this.p.atrLen + 1)), this.p.atrLen) / bar.close;
    if (!(atrPct > 0)) return;
    const idxAgo = this.bars.length - 1 - this.p.overnightBars;
    const closeAgo = idxAgo >= 0 ? this.bars[idxAgo]?.close : undefined;
    if (!closeAgo || closeAgo <= 0) return;
    if ((bar.close - closeAgo) / closeAgo > -this.p.overnightDropPct) return; // no overnight flush → don't arm

    const bid = bar.close * (1 - this.p.kAtr * atrPct);
    const qty = fixedFractionQty(this.ctx, bid, this.p.entryFrac);
    if (qty <= 0) return;
    void this.ctx.submit({ kind: 'LIMIT', side: 'BUY', price: bid, qty });
    this.bidResting = true;
    this.armAtrPct = atrPct;
  }

  onFill(f: Fill): void {
    // Bookkeeping only — onBar decides off position()/avgEntry. Logs so fills show in metrics.
    this.ctx.log.info(`morningmean fill ${f.side} ${f.qty}@${f.price} ${f.isMaker ? 'maker' : 'taker'}`);
  }
}

const factory: StrategyFactory = {
  id: 'morningmean',
  paramSchema: {
    startH: { type: 'number', default: 9, min: 0, max: 23, desc: 'KST window start hour (inclusive)' },
    endH: { type: 'number', default: 12, min: 1, max: 24, desc: 'KST window end hour (exclusive)' },
    overnightBars: { type: 'number', default: 360, min: 30, max: 1440, desc: 'lookback bars for the overnight-drop arm' },
    overnightDropPct: { type: 'number', default: 0.02, min: 0.002, max: 0.2, desc: 'arm when return over overnightBars ≤ −this (0.02 = 2%)' },
    atrLen: { type: 'number', default: 14, min: 5, max: 60, desc: 'bars of 1m ATR' },
    kAtr: { type: 'number', default: 1.5, min: 0.25, max: 8, desc: 'entry bid depth below price, in units of ATR%' },
    mAtr: { type: 'number', default: 2, min: 0.25, max: 10, desc: 'take-profit above entry, in units of ATR%' },
    maxBars: { type: 'number', default: 90, min: 5, max: 600, desc: 'time-stop: flatten after this many held bars' },
    entryFrac: { type: 'number', default: 0.5, min: 0.01, max: 1, desc: 'equity fraction per entry (quote)' },
  },
  create: () => new MorningMean(),
};

export default factory;
