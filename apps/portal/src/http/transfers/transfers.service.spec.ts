import { MarketType } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { JournalWriter } from '@app/core-domain/ledger/journal-writer';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { TransfersService } from './transfers.service';

// futures→spot 출금 게이트가 차감과 같은 트랜잭션에서(차감 후) 실행되는지 검증
// + S0 저널 미러(양 leg) 배선 검증

function makeJournal() {
  return {
    writeInTx: jest.fn(() => Promise.resolve({ seq: 1 })),
    writeManyInTx: jest.fn(() => Promise.resolve([{ seq: 1 }, { seq: 2 }])),
  } as unknown as JournalWriter;
}

function makeDb(over: { pendingLegs?: unknown[][]; liquidating?: boolean } = {}) {
  const calls: string[] = [];
  const tx = {
    wallet: {
      updateMany: jest.fn(() => {
        calls.push('debit');
        return Promise.resolve({ count: 1 });
      }),
      upsert: jest.fn(() => {
        calls.push('credit');
        return Promise.resolve({});
      }),
    },
    position: {
      findFirst: jest.fn(() => {
        calls.push('gate:position');
        return Promise.resolve(over.liquidating ? { tickerSymbol: 'BTCUSDT' } : null);
      }),
    },
    settlementEvent: {
      findMany: jest.fn(() => {
        calls.push('gate:events');
        return Promise.resolve((over.pendingLegs ?? []).map((legs) => ({ legs })));
      }),
    },
    fundingTx: { create: jest.fn(() => Promise.resolve({ id: 'ftx_1' })) },
    futuresIncome: { create: jest.fn(() => Promise.resolve({})) },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => Promise<void>) => fn(tx) };
  return { prisma: prisma as unknown as PrismaService, tx, calls };
}

const dto = {
  fromMarket: MarketType.FUTURES,
  toMarket: MarketType.SPOT,
  assetSymbol: 'USDT',
  qty: '100',
};

describe('TransfersService — futures 출금 게이트', () => {
  it('게이트는 wallet 차감 후 같은 tx 안에서 실행된다 (TOCTOU 윈도 차단)', async () => {
    const { prisma, calls } = makeDb();
    const service = new TransfersService(prisma, makeJournal());
    await service.transfer('A', dto as never);
    expect(calls.indexOf('debit')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('debit')).toBeLessThan(calls.indexOf('gate:position'));
    expect(calls.indexOf('gate:position')).toBeLessThan(calls.indexOf('credit'));
  });

  it('차감 후 게이트에서 본인 PENDING futures 이벤트 발견 시 throw — tx 롤백', async () => {
    const { prisma } = makeDb({ pendingLegs: [[{ makerUserId: 'A' }]] });
    const service = new TransfersService(prisma, makeJournal());
    // 예외 타입만 DomainException으로 갱신 (메시지/HTTP 400 동작은 동일 — 동작 보존 위반 아님)
    await expect(service.transfer('A', dto as never)).rejects.toThrow(DomainException);
  });

  it('LIQUIDATING 포지션이면 거부', async () => {
    const { prisma } = makeDb({ liquidating: true });
    const service = new TransfersService(prisma, makeJournal());
    await expect(service.transfer('A', dto as never)).rejects.toThrow('position is liquidating');
  });

  it('spot→futures 입금은 게이트를 타지 않는다', async () => {
    const { prisma, tx, calls } = makeDb();
    const service = new TransfersService(prisma, makeJournal());
    await service.transfer('A', {
      ...dto,
      fromMarket: MarketType.SPOT,
      toMarket: MarketType.FUTURES,
    } as never);
    expect(calls).not.toContain('gate:position');
    expect(tx.settlementEvent.findMany).not.toHaveBeenCalled();
  });

  it('S0: 양 leg 저널을 각 마켓으로 1건씩, Wallet 델타와 동일하게 기록한다', async () => {
    const { prisma } = makeDb();
    const journal = makeJournal();
    const service = new TransfersService(prisma, journal);
    await service.transfer('A', dto as never); // FUTURES → SPOT, qty 100

    expect(journal.writeManyInTx).toHaveBeenCalledTimes(1);
    const legs = (journal.writeManyInTx as jest.Mock).mock.calls[0][1] as Array<{
      marketType: MarketType;
      deltaBalance: { toString(): string };
      deltaLocked: { toString(): string };
      sourceKey: string;
      kind: string;
    }>;
    expect(legs).toHaveLength(2);
    // from leg = 차감(-100) on FUTURES, sourceKey는 fundingTx.id로 to leg와 짝
    expect(legs[0].marketType).toBe(MarketType.FUTURES);
    expect(legs[0].deltaBalance.toString()).toBe('-100');
    expect(legs[0].deltaLocked.toString()).toBe('0');
    expect(legs[0].sourceKey).toBe('xferout:ftx_1');
    expect(legs[0].kind).toBe('TRANSFER');
    // to leg = 가산(+100) on SPOT
    expect(legs[1].marketType).toBe(MarketType.SPOT);
    expect(legs[1].deltaBalance.toString()).toBe('100');
    expect(legs[1].sourceKey).toBe('xferin:ftx_1');
  });
});
