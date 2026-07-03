import { PrismaService } from '@app/infra/prisma/prisma.service';
import { UserStreamService } from '../user-stream/user-stream.service';
import { SettlementWorker } from './settlement.worker';

// leg 적용의 wallet 생성 규칙 검증 — 순수 credit leg만 행을 만들 수 있다(첫 수령 자산).

function makeDb(over: { claimCount?: number } = {}) {
  const tx = {
    settlementEvent: {
      updateMany: jest.fn(() => Promise.resolve({ count: over.claimCount ?? 1 })),
    },
    wallet: {
      upsert: jest.fn(() => Promise.resolve({ updatedAt: new Date() })),
      update: jest.fn(() => Promise.resolve({ updatedAt: new Date() })),
    },
    order: { update: jest.fn(() => Promise.resolve({})) },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { prisma: prisma as unknown as PrismaService, tx };
}

function makeEvent(legs: Array<{ lockedDelta: string; balanceDelta: string }>) {
  return {
    id: 'evt-1',
    kind: 'TRADE',
    legs: legs.map((l) => ({
      userId: 'A',
      assetSymbol: 'BTC',
      marketType: 'SPOT',
      ...l,
    })),
    orderLegs: [],
  };
}

function makeWorker(prisma: PrismaService) {
  return new SettlementWorker(prisma, {} as UserStreamService);
}

describe('SettlementWorker — leg 적용', () => {
  it('순수 credit leg는 upsert — 첫 수령 자산이면 행을 생성한다', async () => {
    const { prisma, tx } = makeDb();
    const worker = makeWorker(prisma) as any;
    await worker.apply(makeEvent([{ lockedDelta: '0', balanceDelta: '0.5' }]));

    expect(tx.wallet.upsert).toHaveBeenCalledTimes(1);
    expect(tx.wallet.update).not.toHaveBeenCalled();
    const arg = tx.wallet.upsert.mock.calls[0][0] as any;
    expect(arg.create.balance.toString()).toBe('0.5');
    expect(arg.create.locked.toString()).toBe('0');
  });

  it('차감이 섞인 leg는 update — 행 부재 시 throw로 드러난다 (조용한 음수 행 생성 금지)', async () => {
    const { prisma, tx } = makeDb();
    const worker = makeWorker(prisma) as any;
    await worker.apply(makeEvent([{ lockedDelta: '-1', balanceDelta: '0.3' }]));

    expect(tx.wallet.update).toHaveBeenCalledTimes(1);
    expect(tx.wallet.upsert).not.toHaveBeenCalled();
  });

  it('leg마다 독립 판정 — credit/debit 혼재 이벤트', async () => {
    const { prisma, tx } = makeDb();
    const worker = makeWorker(prisma) as any;
    await worker.apply(
      makeEvent([
        { lockedDelta: '0', balanceDelta: '0.5' }, // 매수자 수령
        { lockedDelta: '-0.5', balanceDelta: '0' }, // 매도자 잠금 해제+차감
      ]),
    );
    expect(tx.wallet.upsert).toHaveBeenCalledTimes(1);
    expect(tx.wallet.update).toHaveBeenCalledTimes(1);
  });

  it('이미 claim된 이벤트는 적용하지 않는다', async () => {
    const { prisma, tx } = makeDb({ claimCount: 0 });
    const worker = makeWorker(prisma) as any;
    await expect(worker.apply(makeEvent([{ lockedDelta: '0', balanceDelta: '1' }]))).rejects.toThrow(
      'already claimed',
    );
    expect(tx.wallet.upsert).not.toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });
});
