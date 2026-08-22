import { MarketType, Wallet } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DriftChecker } from './drift-checker';
import { LedgerService } from './ledger.service';

const SPOT = MarketType.SPOT;

function wallet(userId: string, balance: string, locked = '0'): Wallet {
  return {
    userId,
    assetSymbol: 'USDT',
    marketType: SPOT,
    balance: new Decimal(balance),
    locked: new Decimal(locked),
    updatedAt: new Date(),
  } as Wallet;
}

function fakePrisma(wallets: Wallet[]): PrismaService {
  return {
    wallet: {
      findMany: jest.fn(async (args: any) => {
        const inMarkets: MarketType[] | undefined = args?.where?.marketType?.in;
        return wallets.filter((w) => !inMarkets || inMarkets.includes(w.marketType));
      }),
    },
  } as unknown as PrismaService;
}

const K = (userId: string) => ({ userId, assetSymbol: 'USDT', marketType: SPOT });

describe('DriftChecker', () => {
  it('returns empty when ledger exactly matches Wallet projection', async () => {
    const led = new LedgerService([SPOT]);
    led.apply(K('u1'), 100_00000000n, 20_00000000n);
    const checker = new DriftChecker(fakePrisma([wallet('u1', '100', '20')]), led);
    expect(await checker.check()).toEqual([]);
  });

  it('detects value mismatch, ledger-only, and wallet-only rows', async () => {
    const led = new LedgerService([SPOT]);
    led.apply(K('u1'), 100_00000000n, 20_00000000n); // matches
    led.apply(K('u2'), 50_00000000n, 0n); // wallet off by 1 sat
    led.apply(K('u3'), 5_00000000n, 0n); // ledger-only (no wallet row)

    const checker = new DriftChecker(
      fakePrisma([
        wallet('u1', '100', '20'),
        wallet('u2', '49.99999999'),
        wallet('u4', '7'), // wallet-only (ledger 0/0)
      ]),
      led,
    );

    const drifts = await checker.check();
    const byUser = new Map(drifts.map((d) => [d.userId, d]));

    expect(byUser.has('u1')).toBe(false); // 일치 → 드리프트 아님
    expect(byUser.get('u2')?.balanceDiff).toBe('0.00000001'); // ledger − wallet
    expect(byUser.get('u3')?.walletBalance).toBeNull(); // 원장에만
    expect(byUser.get('u3')?.balanceDiff).toBe('5.00000000');
    expect(byUser.get('u4')?.ledgerBalance).toBe('0.00000000'); // Wallet에만
    expect(byUser.get('u4')?.balanceDiff).toBe('-7.00000000');
    expect(drifts).toHaveLength(3);
  });

  describe('checkPersistent (S2: 같은 키 AND 같은 diff 2틱 연속)', () => {
    it('핫 키 랙: 같은 키가 diff 7.25→3.10으로 변하며 2틱 연속 → persistent 0 (오탐 제거)', async () => {
      const led = new LedgerService([SPOT]);
      led.apply(K('bot'), 100_00000000n, 0n); // 원장 고정 100
      // 프로젝터 랙 시뮬 — wallet이 매 틱 다른 값 (diff 7.25 → 3.10)
      let balance = '92.75';
      const prisma = {
        wallet: { findMany: jest.fn(async () => [wallet('bot', balance)]) },
      } as unknown as PrismaService;
      const checker = new DriftChecker(prisma, led);

      const t1 = await checker.checkPersistent();
      expect(t1.all.map((d) => d.balanceDiff)).toEqual(['7.25000000']);
      expect(t1.persistent).toHaveLength(0);

      balance = '96.9'; // 다음 틱 랙 diff = 3.10
      const t2 = await checker.checkPersistent();
      expect(t2.all.map((d) => d.balanceDiff)).toEqual(['3.10000000']);
      expect(t2.persistent).toHaveLength(0); // diff가 변함 → 랙, 누수 아님
    });

    it('진짜 누수: 같은 키 diff 7.25 고정 2틱 → persistent 1 (검출 유지)', async () => {
      const led = new LedgerService([SPOT]);
      led.apply(K('bot'), 100_00000000n, 0n);
      const checker = new DriftChecker(fakePrisma([wallet('bot', '92.75')]), led);

      const t1 = await checker.checkPersistent();
      expect(t1.persistent).toHaveLength(0);

      const t2 = await checker.checkPersistent(); // 같은 diff 7.25 재관측
      expect(t2.persistent.map((d) => [d.userId, d.balanceDiff])).toEqual([
        ['bot', '7.25000000'],
      ]);
    });

    it('첫 틱 드리프트는 persistent 아님, 같은 키가 2틱 연속이면 persistent', async () => {
      const led = new LedgerService([SPOT]);
      led.apply(K('u2'), 50_00000000n, 0n); // wallet과 1 sat 불일치 (지속 드리프트)
      const checker = new DriftChecker(fakePrisma([wallet('u2', '49.99999999')]), led);

      // 틱1: 드리프트 관측되나 직전 기록 없음 → persistent 비어 있음
      const t1 = await checker.checkPersistent();
      expect(t1.all).toHaveLength(1);
      expect(t1.persistent).toHaveLength(0);

      // 틱2: 같은 키가 또 드리프트 → persistent
      const t2 = await checker.checkPersistent();
      expect(t2.all).toHaveLength(1);
      expect(t2.persistent.map((d) => d.userId)).toEqual(['u2']);
    });

    it('순간 드리프트(다음 틱 해소)는 persistent로 승격되지 않음', async () => {
      const led = new LedgerService([SPOT]);
      led.apply(K('u2'), 50_00000000n, 0n);
      // 틱1은 불일치, 틱2는 일치하도록 wallet 값을 스왑하는 fake
      let balance = '49.99999999';
      const prisma = {
        wallet: { findMany: jest.fn(async () => [wallet('u2', balance)]) },
      } as unknown as PrismaService;
      const checker = new DriftChecker(prisma, led);

      const t1 = await checker.checkPersistent();
      expect(t1.all).toHaveLength(1);
      expect(t1.persistent).toHaveLength(0);

      balance = '50'; // 프로젝터가 따라잡음
      const t2 = await checker.checkPersistent();
      expect(t2.all).toHaveLength(0);
      expect(t2.persistent).toHaveLength(0); // 승격 안 됨
    });
  });
});
