import { BalanceJournalKind, MarketType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { JournalTailer } from './journal-tailer';
import { LedgerAvailability } from './ledger-availability';
import { LedgerBaseliner } from './ledger-baseliner';
import { LedgerService } from './ledger.service';

const SPOT = MarketType.SPOT;
const AVAILABLE = { enabled: true } as LedgerAvailability;
const DISABLED = { enabled: false } as LedgerAvailability;

interface JRow {
  seq: number;
  sourceKey: string;
  userId: string;
  assetSymbol: string;
  marketType: MarketType;
  kind: BalanceJournalKind;
  deltaBalance: Decimal;
  deltaLocked: Decimal;
}

interface WRow {
  userId: string;
  assetSymbol: string;
  marketType: MarketType;
  balance: Decimal;
  locked: Decimal;
}

/** 저널+지갑 인메모리 fake — findFirst/findMany/createMany와 $transaction(같은 스토어)을 흉내. */
class FakeDb {
  journal: JRow[] = [];
  wallets: WRow[] = [];
  private nextSeq = 1;
  readonly txSpy = jest.fn();
  readonly createManySpy = jest.fn();

  readonly prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      this.txSpy();
      return fn(this.txClient());
    },
    balanceJournal: {
      findMany: async (args: any) => {
        let rows = this.filterJournal(args?.where);
        if (args?.take) rows = rows.slice(0, args.take);
        return rows;
      },
    },
  } as unknown as PrismaService;

  addWallet(userId: string, balance: string, locked = '0'): void {
    this.wallets.push({
      userId,
      assetSymbol: 'USDT',
      marketType: SPOT,
      balance: new Decimal(balance),
      locked: new Decimal(locked),
    });
  }

  addJournal(userId: string, kind: BalanceJournalKind, deltaBalance: string, sourceKey: string): void {
    this.journal.push({
      seq: this.nextSeq++,
      sourceKey,
      userId,
      assetSymbol: 'USDT',
      marketType: SPOT,
      kind,
      deltaBalance: new Decimal(deltaBalance),
      deltaLocked: new Decimal(0),
    });
  }

  private txClient() {
    return {
      balanceJournal: {
        findFirst: async (args: any) => {
          const rows = this.filterJournal(args?.where);
          return rows.length > 0 ? { seq: rows[0].seq } : null;
        },
        createMany: async (args: { data: any[] }) => {
          this.createManySpy(args);
          for (const d of args.data) {
            if (this.journal.some((r) => r.sourceKey === d.sourceKey)) {
              throw new Error(`unique violation: ${d.sourceKey}`);
            }
            this.journal.push({ ...d, seq: this.nextSeq++ });
          }
          return { count: args.data.length };
        },
      },
      wallet: {
        findMany: async (args: any) =>
          this.wallets.filter(
            (w) => !args?.where?.marketType || w.marketType === args.where.marketType,
          ),
      },
    };
  }

  private filterJournal(where: any): JRow[] {
    let rows = [...this.journal].sort((a, b) => a.seq - b.seq);
    if (!where) return rows;
    if (typeof where.marketType === 'string') {
      rows = rows.filter((r) => r.marketType === where.marketType);
    } else if (where.marketType?.in) {
      rows = rows.filter((r) => where.marketType.in.includes(r.marketType));
    }
    if (where.kind) rows = rows.filter((r) => r.kind === where.kind);
    if (where.seq?.gt !== undefined) rows = rows.filter((r) => r.seq > where.seq.gt);
    return rows;
  }
}

const scaled = (led: LedgerService, userId: string) =>
  led.getScaled({ userId, assetSymbol: 'USDT', marketType: SPOT });

describe('LedgerBaseliner', () => {
  it('first activation: writes one BASELINE per wallet row in a single tx', async () => {
    const db = new FakeDb();
    db.addWallet('u1', '100.5', '20');
    db.addWallet('u2', '0.00000001');
    const led = new LedgerService([SPOT]);
    const baseliner = new LedgerBaseliner(db.prisma, led, AVAILABLE);

    const [res] = await baseliner.baseline();
    expect(res).toEqual({ market: SPOT, created: 2, status: 'baselined' });
    expect(db.txSpy).toHaveBeenCalledTimes(1); // 체크+기록 단일 tx
    expect(db.createManySpy).toHaveBeenCalledTimes(1); // 기록도 단일 stmt

    const rows = db.journal.filter((r) => r.kind === BalanceJournalKind.BASELINE);
    expect(rows).toHaveLength(2);
    const u1 = rows.find((r) => r.userId === 'u1')!;
    expect(u1.sourceKey).toBe('baseline:u1:USDT:SPOT');
    expect(u1.deltaBalance.toString()).toBe('100.5');
    expect(u1.deltaLocked.toString()).toBe('20');
  });

  it('reboot idempotency: second run skips (marker = existing BASELINE)', async () => {
    const db = new FakeDb();
    db.addWallet('u1', '100');
    const led = new LedgerService([SPOT]);
    const baseliner = new LedgerBaseliner(db.prisma, led, AVAILABLE);

    await baseliner.baseline();
    const [second] = await baseliner.baseline(); // 재부팅 시뮬
    expect(second).toEqual({ market: SPOT, created: 0, status: 'already-baselined' });
    expect(db.createManySpy).toHaveBeenCalledTimes(1); // 추가 기록 없음
    expect(db.journal).toHaveLength(1);
  });

  it('new wallet after baseline: skipped by baseliner, covered by its journal entries from 0', async () => {
    const db = new FakeDb();
    db.addWallet('u1', '100.5', '20');
    const led = new LedgerService([SPOT]);
    const baseliner = new LedgerBaseliner(db.prisma, led, AVAILABLE);
    const tailer = new JournalTailer(db.prisma, led, AVAILABLE);

    await baseliner.baseline();
    // 이후 u3 지갑이 저널 경유로 생김 (DEPOSIT이 0에서 만듦) + Wallet 행도 등장
    db.addWallet('u3', '7');
    db.addJournal('u3', BalanceJournalKind.DEPOSIT, '7', 'deposit:tx1');

    const [again] = await baseliner.baseline(); // 재부팅 — u3를 baseline하지 않는다
    expect(again.status).toBe('already-baselined');

    await tailer.replayAll();
    expect(scaled(led, 'u1')).toEqual({ balance: 100_50000000n, locked: 20_00000000n }); // BASELINE
    expect(scaled(led, 'u3')).toEqual({ balance: 7_00000000n, locked: 0n }); // 0 + DEPOSIT
  });

  it('empty market first activation: zero wallets → zero entries, still "baselined"', async () => {
    const db = new FakeDb();
    const baseliner = new LedgerBaseliner(db.prisma, new LedgerService([SPOT]), AVAILABLE);
    const [res] = await baseliner.baseline();
    expect(res).toEqual({ market: SPOT, created: 0, status: 'baselined' });
    expect(db.createManySpy).not.toHaveBeenCalled();
  });

  it('guard: journal has entries but no BASELINE → skip with error status (no double count)', async () => {
    const db = new FakeDb();
    db.addWallet('u9', '7'); // 이 7은 이미 저널(DEPOSIT)로 반영된 값 — baseline하면 이중 계상
    db.addJournal('u9', BalanceJournalKind.DEPOSIT, '7', 'deposit:tx9');
    const baseliner = new LedgerBaseliner(db.prisma, new LedgerService([SPOT]), AVAILABLE);

    const [res] = await baseliner.baseline();
    expect(res).toEqual({ market: SPOT, created: 0, status: 'journal-not-empty' });
    expect(db.createManySpy).not.toHaveBeenCalled();
  });

  it('degraded: no db contact at all', async () => {
    const db = new FakeDb();
    db.addWallet('u1', '100');
    const baseliner = new LedgerBaseliner(db.prisma, new LedgerService([SPOT]), DISABLED);
    const [res] = await baseliner.baseline();
    expect(res).toEqual({ market: SPOT, created: 0, status: 'disabled' });
    expect(db.txSpy).not.toHaveBeenCalled();
  });
});
