import { MarketType, OrderSide, OrderType, TimeInForce } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { JournalWriter } from '@app/core-domain/ledger/journal-writer';
import { LedgerService } from '@app/core-domain/ledger/ledger.service';
import { MarginService, OrderDraft } from '../margin/margin.service';

// ADR-069 S0 배선 검증: futures 잔고 저널이 wallet 변이를 정확히 미러링(드리프트 0 by construction)하고
// 커밋 후 원장에 즉시 반영되는지, 강등 시엔 무저널·무크래시로 거래 경로가 불변인지 고정한다.

const FUTURES_KEY = { userId: 'A', assetSymbol: 'USDT', marketType: MarketType.FUTURES };
const E8 = 100_000_000n;

function draft(overrides: Partial<OrderDraft> = {}): OrderDraft {
  return {
    userId: 'A',
    clientOrderId: 'c1',
    symbol: 'BTCUSDT',
    type: OrderType.LIMIT,
    side: OrderSide.BUY,
    timeInForce: TimeInForce.GTC,
    price: new Decimal(50000),
    qty: new Decimal(0.1),
    reduceOnly: false,
    cost: new Decimal(100),
    lockAssetSymbol: 'USDT',
    ...overrides,
  };
}

/** 실 JournalWriter/LedgerService + fake tx(balanceJournal 포함). availability는 스텁. */
function makeMargin(opts: { enabled?: boolean; debitCount?: number; claimCount?: number } = {}) {
  const { enabled = true, debitCount = 1, claimCount = 1 } = opts;
  const journals: Array<Record<string, unknown>> = [];
  let seq = 0;
  const tx = {
    order: {
      create: jest.fn((a: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'ord-1', ...a.data }),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: claimCount })),
    },
    wallet: { updateMany: jest.fn(() => Promise.resolve({ count: debitCount })) },
    balanceJournal: {
      create: jest.fn((a: { data: Record<string, unknown> }) => {
        const row = { id: `bj-${++seq}`, seq, createdAt: new Date(), ...a.data };
        journals.push(row);
        return Promise.resolve(row);
      }),
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    wallet: { findUnique: jest.fn(() => Promise.resolve({ userId: 'A' })) },
  };
  const journalWriter = new JournalWriter(prisma as never, { enabled } as never);
  const ledger = new LedgerService([MarketType.FUTURES]);
  // 이 스펙은 S0 섀도 배선(Wallet 행 차감 + 병행 저널) 검증 — 워커 availability는 disabled로 진실
  // 스위치 OFF 고정. journalWriter는 opts.enabled(강등 케이스)로 별도 제어.
  const service = new MarginService(
    prisma as never,
    journalWriter,
    ledger,
    { enabled: false } as never,
  );
  return { service, ledger, journals, tx };
}

describe('futures ledger S0 wiring — place lock', () => {
  it('createOrder: FUTURES_PLACE_LOCK 저널이 wallet 차감을 정확히 미러링 + 원장 즉시 반영', async () => {
    const m = makeMargin();
    await m.service.createOrder(draft());

    expect(m.journals).toHaveLength(1);
    const j = m.journals[0];
    expect(j.kind).toBe('FUTURES_PLACE_LOCK');
    expect((j.deltaBalance as Decimal).toString()).toBe('-100'); // balance −cost
    expect((j.deltaLocked as Decimal).toString()).toBe('100'); // locked +cost
    expect(j.sourceKey).toBe('lock:ord-1');

    // 커밋 후 로컬 반영: 원장 델타가 wallet 변이와 동일 (드리프트 0)
    const scaled = m.ledger.getScaled(FUTURES_KEY);
    expect(scaled.balance).toBe(-100n * E8);
    expect(scaled.locked).toBe(100n * E8);
  });

  it('강등(availability disabled): 저널 미기록·원장 무변화이나 주문은 정상 생성 (거래 경로 불변)', async () => {
    const m = makeMargin({ enabled: false });
    const order = await m.service.createOrder(draft());

    expect(order).toBeDefined();
    expect(m.tx.balanceJournal.create).not.toHaveBeenCalled();
    expect(m.journals).toHaveLength(0);
    expect(m.ledger.size()).toBe(0);
  });
});

describe('futures ledger S0 wiring — stop arm', () => {
  it('arm 취소 선점(lost): lock + unlock 두 저널, 순 델타 0, 별도 sourceKey', async () => {
    const m = makeMargin({ claimCount: 0 }); // claim 0건 = 취소 선점
    const res = await m.service.armTriggeredStop({
      orderId: 'o9',
      userId: 'A',
      lockAssetSymbol: 'USDT',
      cost: new Decimal(50),
    });

    expect(res).toBe('lost');
    expect(m.journals.map((j) => j.kind)).toEqual(['FUTURES_PLACE_LOCK', 'FUTURES_PLACE_UNLOCK']);
    expect(m.journals[0].sourceKey).toBe('lock:o9');
    expect(m.journals[1].sourceKey).toBe('unlock:o9');

    // lock(−50/+50) 후 unlock(+50/−50) → 원장 순 델타 0
    const scaled = m.ledger.getScaled(FUTURES_KEY);
    expect(scaled.balance).toBe(0n);
    expect(scaled.locked).toBe(0n);
  });

  it('잔고 부족(insufficient): 차감 0건이면 저널 없음', async () => {
    const m = makeMargin({ debitCount: 0 });
    const res = await m.service.armTriggeredStop({
      orderId: 'o9',
      userId: 'A',
      lockAssetSymbol: 'USDT',
      cost: new Decimal(50),
    });

    expect(res).toBe('insufficient');
    expect(m.journals).toHaveLength(0);
  });
});
