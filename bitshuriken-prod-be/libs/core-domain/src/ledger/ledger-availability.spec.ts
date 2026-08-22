import { BalanceJournalKind, MarketType, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { JournalTailer } from './journal-tailer';
import { JournalWriter } from './journal-writer';
import { LedgerAvailability } from './ledger-availability';
import { LedgerService } from './ledger.service';
import { JournalInput } from './ledger.types';

const SPOT = MarketType.SPOT;

const p2021 = () =>
  new Prisma.PrismaClientKnownRequestError('relation does not exist', {
    code: 'P2021',
    clientVersion: 'test',
  });

function prismaWith(findFirst: jest.Mock): PrismaService {
  return { balanceJournal: { findFirst } } as unknown as PrismaService;
}

/** 강등 중 DB/tx 접촉을 시도하면 즉시 터지는 프록시. */
const untouchable = <T>(label: string): T =>
  new Proxy(
    {},
    {
      get() {
        throw new Error(`${label} must not be touched while degraded`);
      },
    },
  ) as T;

const input: JournalInput = {
  userId: 'u1',
  assetSymbol: 'USDT',
  marketType: SPOT,
  kind: BalanceJournalKind.DEPOSIT,
  deltaBalance: new Decimal(1),
  deltaLocked: new Decimal(0),
  sourceKey: 'deposit:x',
};

describe('LedgerAvailability (부트 강등 체크)', () => {
  it('enables when the table probe succeeds; false before probe', async () => {
    const avail = new LedgerAvailability(prismaWith(jest.fn().mockResolvedValue(null)));
    expect(avail.enabled).toBe(false); // probe 전 확정 전 false
    await avail.onModuleInit();
    expect(avail.enabled).toBe(true);
  });

  it('degrades on P2021 (table missing) and probes only once', async () => {
    const findFirst = jest.fn().mockRejectedValue(p2021());
    const avail = new LedgerAvailability(prismaWith(findFirst));
    await avail.onModuleInit();
    expect(avail.enabled).toBe(false);
    await avail.probe(); // 재호출은 캐시 — 재프로브 없음
    expect(avail.enabled).toBe(false);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-schema errors (fail loudly)', async () => {
    const avail = new LedgerAvailability(
      prismaWith(jest.fn().mockRejectedValue(new Error('connection refused'))),
    );
    await expect(avail.probe()).rejects.toThrow('connection refused');
  });

  describe('degraded no-ops', () => {
    const disabled = { enabled: false } as LedgerAvailability;

    it('writer no-ops without issuing any stmt on caller tx / db', async () => {
      const writer = new JournalWriter(untouchable<PrismaService>('prisma'), disabled);
      const tx = untouchable<Prisma.TransactionClient>('tx');
      await expect(writer.writeInTx(tx, input)).resolves.toBeNull();
      await expect(writer.writeManyInTx(tx, [input])).resolves.toEqual([]);
      await expect(writer.write(input)).resolves.toBeNull();
    });

    it('tailer tick/replayAll are inert and do not reset the ledger', async () => {
      const led = new LedgerService([SPOT]);
      led.apply({ userId: 'u1', assetSymbol: 'USDT', marketType: SPOT }, 5_00000000n, 0n);
      const tailer = new JournalTailer(untouchable<PrismaService>('prisma'), led, disabled);

      await expect(tailer.tick()).resolves.toMatchObject({ fetched: 0, applied: 0, watermark: 0 });
      await expect(tailer.replayAll()).resolves.toEqual({ applied: 0, watermark: 0 });
      // 강등 replay가 원장을 reset하지 않았음
      expect(
        led.getScaled({ userId: 'u1', assetSymbol: 'USDT', marketType: SPOT }).balance,
      ).toBe(5_00000000n);
    });
  });
});
