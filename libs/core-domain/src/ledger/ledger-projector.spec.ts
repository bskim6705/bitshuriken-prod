import { MarketType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { LedgerAvailability } from './ledger-availability';
import { LedgerProjector } from './ledger-projector';
import { LedgerService } from './ledger.service';
import { WalletKeyParts } from './ledger.types';

// LEDGER_TRUTH=true 전제(코드 상수). availability로 on/off, 절대값 멱등/부트 전량→dirty 전환을 고정.

const SPOT = MarketType.SPOT;
const key = (userId: string): WalletKeyParts => ({ userId, assetSymbol: 'USDT', marketType: SPOT });

interface Upsert {
  where: unknown;
  create: { balance: Decimal; locked: Decimal };
  update: { balance: Decimal; locked: Decimal };
}

function makeProjector(enabled: boolean) {
  const upserts: Upsert[] = [];
  // upsert는 op 토큰(Promise)을 반환하고, 실제 실행은 $transaction이 배열로 받아 한 번에 한다.
  const txCalls: unknown[][] = [];
  const prisma = {
    wallet: {
      upsert: jest.fn((a: Upsert) => {
        upserts.push(a);
        return Promise.resolve({});
      }),
    },
    $transaction: jest.fn((ops: unknown[]) => {
      txCalls.push(ops);
      return Promise.all(ops as Promise<unknown>[]);
    }),
  };
  const ledger = new LedgerService([SPOT]);
  const availability = { enabled } as unknown as LedgerAvailability;
  const projector = new LedgerProjector(prisma as never, ledger, availability);
  return { projector, ledger, upserts, txCalls };
}

describe('LedgerProjector', () => {
  it('강등(availability disabled): no-op (Wallet 행이 진실이라 덮어쓰기 금지)', async () => {
    const { projector, ledger, upserts } = makeProjector(false);
    ledger.apply(key('u1'), 100_00000000n, 0n);
    expect(await projector.project()).toEqual({ projected: 0 });
    expect(upserts).toHaveLength(0);
  });

  it('부트 후 최초 1회는 전 키, 이후 dirty만', async () => {
    const { projector, ledger, upserts } = makeProjector(true);
    ledger.apply(key('u1'), 100_00000000n, 0n);
    ledger.apply(key('u2'), 50_00000000n, 0n);
    ledger.drainDirty(); // dirty를 비워도 최초 project는 allKeys로 전량 반영해야 함

    expect((await projector.project()).projected).toBe(2); // 전 키
    upserts.length = 0;

    // 변이 없으면 dirty 비어 no-op
    expect((await projector.project()).projected).toBe(0);
    // u2만 변이 → dirty만
    ledger.apply(key('u2'), 5_00000000n, 0n);
    expect((await projector.project()).projected).toBe(1);
    expect((upserts[0].update.balance as Decimal).toFixed(8)).toBe('55.00000000');
  });

  it('배치화: dirty 키 전부를 틱당 단일 $transaction으로, 값 정확', async () => {
    const { projector, ledger, upserts, txCalls } = makeProjector(true);
    ledger.apply(key('u1'), 100_00000000n, 0n);
    ledger.apply(key('u2'), 40_00000000n, 0n);
    ledger.reserve(key('u2'), '15', 'lock:o1'); // u2: 25 free / 15 locked

    const res = await projector.project(); // 최초 전량 (u1,u2)
    expect(res.projected).toBe(2);
    expect(txCalls).toHaveLength(1); // 직렬 왕복이 아니라 단일 tx
    expect(txCalls[0]).toHaveLength(2); // 두 upsert op이 한 배열로
    expect(upserts).toHaveLength(2);

    const byBal = (v: string) => upserts.find((u) => u.update.balance.toFixed(8) === v)!;
    expect(byBal('100.00000000').update.locked.toFixed(8)).toBe('0.00000000'); // u1
    const u2 = byBal('25.00000000');
    expect(u2.update.locked.toFixed(8)).toBe('15.00000000'); // u2 reserve 반영
  });

  it('dirty 0이면 $transaction 미호출 (no-op)', async () => {
    const { projector, ledger, txCalls } = makeProjector(true);
    ledger.apply(key('u1'), 10_00000000n, 0n);
    await projector.project(); // 부트 전량 (allKeys — dirty 미배출)
    ledger.drainDirty(); // 부트 창 dirty 비움
    txCalls.length = 0;
    expect((await projector.project()).projected).toBe(0); // 변이 없음
    expect(txCalls).toHaveLength(0);
  });

  it('절대값 멱등: 같은 상태를 두 번 프로젝션하면 동일 절대값 upsert', async () => {
    const { projector, ledger, upserts } = makeProjector(true);
    ledger.apply(key('u1'), 40_00000000n, 0n);
    ledger.reserve(key('u1'), '15', 'lock:o1'); // 25 free / 15 locked

    await projector.project(); // 최초 전량
    const first = upserts[upserts.length - 1];
    expect(first.update.balance.toFixed(8)).toBe('25.00000000');
    expect(first.update.locked.toFixed(8)).toBe('15.00000000');

    // 크래시 후 재부팅 흉내 — 전 키 재프로젝션이 같은 절대값을 쓴다(멱등)
    upserts.length = 0;
    (projector as unknown as { booted: boolean }).booted = false;
    await projector.project();
    const again = upserts[upserts.length - 1];
    expect(again.update.balance.toFixed(8)).toBe('25.00000000');
    expect(again.update.locked.toFixed(8)).toBe('15.00000000');
  });
});
