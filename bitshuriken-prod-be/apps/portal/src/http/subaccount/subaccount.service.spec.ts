import { MarketType } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { ApiKeyService } from '@app/core-domain/api-key/api-key.service';
import { TwoFactorService } from '@app/core-domain/two-factor/two-factor.service';
import { JournalWriter } from '@app/core-domain/ledger/journal-writer';
import { SubaccountService } from './subaccount.service';

// S0 저널 미러: 계정 간 이체가 양 leg(from/to)를 out.id로 짝지어 같은 마켓·반대 부호로 기록하는지 검증

function makeJournal() {
  return {
    writeInTx: jest.fn(() => Promise.resolve({ seq: 1 })),
    writeManyInTx: jest.fn(() => Promise.resolve([{ seq: 1 }, { seq: 2 }])),
  } as unknown as JournalWriter;
}

function makeDb() {
  let n = 0;
  const tx = {
    wallet: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      upsert: jest.fn(() => Promise.resolve({})),
    },
    position: { findFirst: jest.fn(() => Promise.resolve(null)) },
    settlementEvent: { findMany: jest.fn(() => Promise.resolve([])) },
    // 첫 create = out(방향 표시용), 둘째 = inc — 저널은 out.id로 양 leg를 짝짓는다
    fundingTx: { create: jest.fn(() => Promise.resolve({ id: n++ === 0 ? 'out_1' : 'inc_1' })) },
    futuresIncome: { createMany: jest.fn(() => Promise.resolve({})) },
  };
  const prisma = {
    // assertOwned: 서브 'S'는 마스터 'M' 소유
    user: { findUnique: jest.fn(() => Promise.resolve({ id: 'S', parentUserId: 'M' })) },
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  return { prisma: prisma as unknown as PrismaService, tx };
}

const apiKeyService = {} as unknown as ApiKeyService;
const twoFactor = {} as unknown as TwoFactorService;

const dto = { fromAccountId: 'M', toAccountId: 'S', assetSymbol: 'USDT', qty: '100' };

describe('SubaccountService — S0 저널 미러', () => {
  it('양 leg를 out.id로 짝지어 같은 마켓·반대 부호로 기록한다', async () => {
    const { prisma } = makeDb();
    const journal = makeJournal();
    const service = new SubaccountService(prisma, apiKeyService, twoFactor, journal);
    await service.transfer('M', dto as never); // M → S, SPOT, qty 100

    expect(journal.writeManyInTx).toHaveBeenCalledTimes(1);
    const legs = (journal.writeManyInTx as jest.Mock).mock.calls[0][1] as Array<{
      userId: string;
      marketType: MarketType;
      deltaBalance: { toString(): string };
      sourceKey: string;
      kind: string;
    }>;
    expect(legs).toHaveLength(2);
    // from leg = 차감(-100), user M
    expect(legs[0].userId).toBe('M');
    expect(legs[0].marketType).toBe(MarketType.SPOT);
    expect(legs[0].deltaBalance.toString()).toBe('-100');
    expect(legs[0].sourceKey).toBe('xferout:out_1');
    expect(legs[0].kind).toBe('TRANSFER');
    // to leg = 가산(+100), user S — 같은 out.id로 짝
    expect(legs[1].userId).toBe('S');
    expect(legs[1].marketType).toBe(MarketType.SPOT);
    expect(legs[1].deltaBalance.toString()).toBe('100');
    expect(legs[1].sourceKey).toBe('xferin:out_1');
  });
});
