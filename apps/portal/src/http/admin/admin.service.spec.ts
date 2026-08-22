import { MarketType } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TwoFactorService } from '@app/core-domain/two-factor/two-factor.service';
import { JournalWriter } from '@app/core-domain/ledger/journal-writer';
import { AdminService } from './admin.service';

// S0 저널 미러: 관리자 잔고 조정이 credit/debit 부호대로 ADMIN_ADJUST를 기록하는지 검증

const twoFactor = {
  assertSatisfied: jest.fn(() => Promise.resolve()),
} as unknown as TwoFactorService;

function makeJournal() {
  return {
    writeInTx: jest.fn(() => Promise.resolve({ seq: 1 })),
    writeManyInTx: jest.fn(() => Promise.resolve([])),
  } as unknown as JournalWriter;
}

function makeDb() {
  const tx = {
    wallet: {
      upsert: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    fundingTx: { create: jest.fn(() => Promise.resolve({ id: 'ftx_1' })) },
    futuresIncome: { create: jest.fn(() => Promise.resolve({})) },
  };
  const prisma = {
    user: { findUnique: jest.fn(() => Promise.resolve({ id: 'U' })) },
    asset: { findUnique: jest.fn(() => Promise.resolve({ symbol: 'USDT' })) },
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  return { prisma: prisma as unknown as PrismaService, tx };
}

const dto = { marketType: MarketType.SPOT, assetSymbol: 'USDT', qty: '1000' };

describe('AdminService.adjustBalance — S0 저널 미러', () => {
  it('credit: ADMIN_ADJUST를 +qty로 기록한다 (Wallet 가산과 동일)', async () => {
    const { prisma } = makeDb();
    const journal = makeJournal();
    const service = new AdminService(prisma, twoFactor, journal);
    await service.adjustBalance('admin', 'U', dto as never, 'credit');

    expect(journal.writeInTx).toHaveBeenCalledTimes(1);
    const entry = (journal.writeInTx as jest.Mock).mock.calls[0][1];
    expect(entry.kind).toBe('ADMIN_ADJUST');
    expect(entry.userId).toBe('U');
    expect(entry.marketType).toBe(MarketType.SPOT);
    expect(entry.deltaBalance.toString()).toBe('1000');
    expect(entry.deltaLocked.toString()).toBe('0');
    expect(entry.sourceKey).toBe('adjust:ftx_1');
  });

  it('debit: ADMIN_ADJUST를 −qty로 기록한다 (Wallet 차감과 동일)', async () => {
    const { prisma } = makeDb();
    const journal = makeJournal();
    const service = new AdminService(prisma, twoFactor, journal);
    await service.adjustBalance('admin', 'U', dto as never, 'debit');

    const entry = (journal.writeInTx as jest.Mock).mock.calls[0][1];
    expect(entry.kind).toBe('ADMIN_ADJUST');
    expect(entry.deltaBalance.toString()).toBe('-1000');
    expect(entry.sourceKey).toBe('adjust:ftx_1');
  });
});
