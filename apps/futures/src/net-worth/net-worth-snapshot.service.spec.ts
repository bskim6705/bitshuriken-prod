import { MarketType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { MarkPriceService } from '../mark-price/mark-price.service';
import { NetWorthSnapshotService } from './net-worth-snapshot.service';

const D = (s: string) => new Decimal(s);

function make(markMap: Record<string, string | null>) {
  const markPrice = {
    tryGetMark: jest.fn((sym: string) => {
      const v = markMap[sym];
      return v === null || v === undefined ? null : new Decimal(v);
    }),
  };
  const svc = new NetWorthSnapshotService(
    {} as unknown as PrismaService,
    markPrice as unknown as MarkPriceService,
  );
  return { svc };
}

describe('NetWorthSnapshotService.valueUser', () => {
  it('values spot holdings (free+locked) at the price map and splits spot vs futures', () => {
    const { svc } = make({});
    const prices = new Map([
      ['BTC', D('50000')],
      ['USDT', D('1')],
    ]);
    const v = svc.valueUser(
      [
        { assetSymbol: 'BTC', marketType: MarketType.SPOT, balance: D('1'), locked: D('0.5') },
        { assetSymbol: 'USDT', marketType: MarketType.SPOT, balance: D('1000'), locked: D('0') },
        { assetSymbol: 'USDT', marketType: MarketType.FUTURES, balance: D('2000'), locked: D('0') },
      ],
      [],
      prices,
    );
    // spot: 1.5 BTC × 50000 + 1000 = 76000; futures wallet: 2000
    expect(v.spotUsdt.toFixed(8)).toBe('76000.00000000');
    expect(v.futuresUsdt.toFixed(8)).toBe('2000.00000000');
    expect(v.totalUsdt.toFixed(8)).toBe('78000.00000000');
    expect(v.breakdown).toHaveLength(3);
  });

  it('adds open-position unrealized PnL (mark) to futures', () => {
    const { svc } = make({ BTCUSDT: '55000' });
    const prices = new Map([['USDT', D('1')]]);
    const v = svc.valueUser(
      [{ assetSymbol: 'USDT', marketType: MarketType.FUTURES, balance: D('1000'), locked: D('0') }],
      [{ tickerSymbol: 'BTCUSDT', entryPrice: D('50000'), qty: D('0.5') }],
      prices,
    );
    // uPnL = (55000−50000)×0.5 = 2500 → futures = 1000 + 2500
    expect(v.futuresUsdt.toFixed(8)).toBe('3500.00000000');
    expect(v.totalUsdt.toFixed(8)).toBe('3500.00000000');
  });

  it('treats positions with no mark price as zero uPnL', () => {
    const { svc } = make({ BTCUSDT: null });
    const prices = new Map([['USDT', D('1')]]);
    const v = svc.valueUser(
      [{ assetSymbol: 'USDT', marketType: MarketType.FUTURES, balance: D('1000'), locked: D('0') }],
      [{ tickerSymbol: 'BTCUSDT', entryPrice: D('50000'), qty: D('0.5') }],
      prices,
    );
    expect(v.futuresUsdt.toFixed(8)).toBe('1000.00000000');
  });

  it('values assets with no known price at 0 and skips zero-balance wallets', () => {
    const { svc } = make({});
    const prices = new Map<string, Decimal>();
    const v = svc.valueUser(
      [
        { assetSymbol: 'FOO', marketType: MarketType.SPOT, balance: D('100'), locked: D('0') },
        { assetSymbol: 'BAR', marketType: MarketType.SPOT, balance: D('0'), locked: D('0') },
      ],
      [],
      prices,
    );
    expect(v.spotUsdt.toFixed(8)).toBe('0.00000000');
    expect(v.breakdown).toHaveLength(1); // zero-balance BAR skipped
  });
});
