import { Position, PositionStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { FuturesTradingService } from './futures-trading.service';

// PATCH positions marginDelta 경로의 행 잠금 순서 가드 — 정산 worker(Position→Wallet)와 교착 금지

describe('FuturesTradingService.updatePosition — marginDelta', () => {
  const position = {
    userId: 'A',
    tickerSymbol: 'BTCUSDT',
    tickerMarket: 'FUTURES',
    qty: new Decimal(1),
    entryPrice: new Decimal(50000),
    isolatedMargin: new Decimal(5000),
    leverage: 10,
    status: PositionStatus.NORMAL,
    updatedAt: new Date(),
  } as unknown as Position;

  function makeService() {
    const calls: string[] = [];
    const tx = {
      position: {
        updateMany: jest.fn(() => {
          calls.push('position');
          return Promise.resolve({ count: 1 });
        }),
      },
      wallet: {
        updateMany: jest.fn(() => {
          calls.push('wallet');
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => Promise<void>) => fn(tx) };
    const service = new FuturesTradingService(
      prisma as never,
      { emit: jest.fn() } as never,
      { metaOf: jest.fn().mockReturnValue({ quoteAsset: 'USDT' }) } as never,
      {} as never,
      { configOf: jest.fn().mockResolvedValue({ maxLeverage: 50 }) } as never,
      { findByUserAndSymbol: jest.fn().mockResolvedValue(position) } as never,
      { tryGetMark: jest.fn().mockReturnValue(new Decimal(50000)) } as never,
      {} as never,
    );
    return { service, calls };
  }

  it('marginDelta>0: Position 갱신 후 Wallet 차감 — 잠금 순서 Position→Wallet', async () => {
    const { service, calls } = makeService();
    await service.updatePosition('A', 'BTCUSDT', { marginDelta: '100' });
    expect(calls).toEqual(['position', 'wallet']);
  });

  it('marginDelta<0: Position 차감 후 Wallet 환급 — 동일 잠금 순서', async () => {
    const { service, calls } = makeService();
    await service.updatePosition('A', 'BTCUSDT', { marginDelta: '-100' });
    expect(calls).toEqual(['position', 'wallet']);
  });
});
