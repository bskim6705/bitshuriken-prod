import { MarketType, OrderSide } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { TickerMeta } from '@app/core-domain/ticker/ticker-stats.service';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { krwTickSize, isKrwTickAligned } from '@app/shared/constants/krw-tick';
import { validateAgainstMeta } from './order-validation';

const d = (v: string | number) => new Decimal(v);

const krwMeta: TickerMeta = {
  symbol: 'BTCKRW',
  marketType: MarketType.SPOT,
  baseAsset: 'BTC',
  quoteAsset: 'KRW',
  pricePrecision: 0,
  qtyPrecision: 8,
  minNotional: d(5000),
};

const usdtMeta: TickerMeta = {
  symbol: 'BTCUSDT',
  marketType: MarketType.SPOT,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  pricePrecision: 2,
  qtyPrecision: 8,
  minNotional: d(5),
};

function limit(meta: TickerMeta, price: Decimal, qty: Decimal) {
  return validateAgainstMeta({
    type: 'LIMIT',
    side: OrderSide.BUY,
    price,
    stopPrice: null,
    origQty: qty,
    origQuoteQty: null,
    meta,
    lastPrice: null,
    bandRefPrice: null,
  });
}

describe('krw-tick', () => {
  it('tier tick sizes (Upbit table)', () => {
    expect(krwTickSize(d(150_000_000)).toFixed()).toBe('1000'); // ≥ 2M
    expect(krwTickSize(d(1_500_000)).toFixed()).toBe('500'); // 1M–2M
    expect(krwTickSize(d(280_000)).toFixed()).toBe('50'); // 100k–500k
    expect(krwTickSize(d(45_000)).toFixed()).toBe('10'); // 10k–100k
    expect(krwTickSize(d(4_000)).toFixed()).toBe('5'); // 1k–10k
    expect(krwTickSize(d(300)).toFixed()).toBe('1'); // 100–1k
  });

  it('alignment', () => {
    expect(isKrwTickAligned(d(145_231_000))).toBe(true); // multiple of 1000
    expect(isKrwTickAligned(d(145_231_500))).toBe(false); // not a multiple of 1000
    expect(isKrwTickAligned(d(4_125))).toBe(true); // tick 5
    expect(isKrwTickAligned(d(4_123))).toBe(false); // not a multiple of 5
    expect(isKrwTickAligned(d(300))).toBe(true); // tick 1
    expect(isKrwTickAligned(d('300.5'))).toBe(false);
  });
});

describe('validateAgainstMeta — KRW tiered tick', () => {
  it('accepts a tier-aligned KRW price', () => {
    expect(() => limit(krwMeta, d(145_231_000), d('0.001'))).not.toThrow();
  });

  it('rejects an off-tick KRW price', () => {
    expect(() => limit(krwMeta, d(145_231_500), d('0.001'))).toThrow(
      expect.objectContaining({ code: ErrorCode.INVALID_PRICE }),
    );
  });

  it('rejects an off-tick KRW stopPrice', () => {
    expect(() =>
      validateAgainstMeta({
        type: 'STOP_LOSS_LIMIT',
        side: OrderSide.SELL,
        price: d(145_230_000),
        stopPrice: d(145_231_500), // off tick (1000)
        origQty: d('0.001'),
        origQuoteQty: null,
        meta: krwMeta,
        lastPrice: null,
        bandRefPrice: null,
      }),
    ).toThrow(expect.objectContaining({ code: ErrorCode.INVALID_PRICE }));
  });

  it('non-KRW still uses decimal-places check (unchanged)', () => {
    expect(() => limit(usdtMeta, d('50000.00'), d('0.001'))).not.toThrow();
    expect(() => limit(usdtMeta, d('50000.123'), d('0.001'))).toThrow(
      expect.objectContaining({ code: ErrorCode.INVALID_PRICE }),
    );
  });
});
