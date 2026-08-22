import { MarketType, OrderSide, OrderType, TimeInForce } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { LedgerService } from '@app/core-domain/ledger/ledger.service';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';
import { MarginService, OrderDraft } from './margin.service';
import { ErrorCode } from '@app/shared/constants/error-codes';

// createOrder 접수 tx의 락 홀드 최소화(주문 먼저→마지막에 조건부 차감) + tx 밖 에러 판별 가드.
// 성공/실패 경로별 최종 상태·에러 코드·statement 순서 불변을 고정한다.

const ORDER = { id: 'o1', status: 'NEW' };

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

/**
 * prisma mock: $transaction(fn)은 tx로 콜백 실행하고 throw는 그대로 전파(실 rollback 동치).
 * debitCount로 조건부 차감 결과를, walletExists로 tx 밖 판별 SELECT 결과를 제어.
 */
function makeService(
  opts: { debitCount?: number; walletExists?: boolean; truth?: boolean } = {},
) {
  const { debitCount = 1, walletExists = true, truth = false } = opts;
  const calls: string[] = [];
  const tx = {
    order: {
      create: jest.fn(() => {
        calls.push('order.create');
        return Promise.resolve(ORDER);
      }),
    },
    wallet: {
      updateMany: jest.fn(() => {
        calls.push('wallet.updateMany');
        return Promise.resolve({ count: debitCount });
      }),
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    order: {
      create: jest.fn(() => {
        calls.push('plain.order.create');
        return Promise.resolve(ORDER);
      }),
    },
    wallet: {
      findUnique: jest.fn(() => {
        calls.push('wallet.findUnique');
        return Promise.resolve(walletExists ? { userId: 'A' } : null);
      }),
    },
  };
  const journalRow = {
    seq: 1,
    sourceKey: 'lock:o1',
    userId: 'A',
    assetSymbol: 'USDT',
    marketType: 'FUTURES',
    deltaBalance: new Decimal(0),
    deltaLocked: new Decimal(0),
  };
  const journalWriter = { writeInTx: jest.fn(() => Promise.resolve(journalRow)) };
  // S0 기본: 원장 no-op 스텁 + availability disabled. truth:true면 실 원장 + enabled.
  const ledger = truth
    ? new LedgerService([MarketType.FUTURES])
    : ({ applyJournal: jest.fn() } as unknown as LedgerService);
  const availability = { enabled: truth } as unknown as LedgerAvailability;
  const service = new MarginService(
    prisma as never,
    journalWriter as never,
    ledger,
    availability,
  );
  return { service, calls, tx, prisma, journalWriter, ledger };
}

describe('MarginService.createOrder', () => {
  it('성공: 주문 생성이 조건부 차감보다 먼저 — 락은 마지막 stmt에서만, 핫패스 findUnique 없음', async () => {
    const { service, calls, prisma } = makeService({ debitCount: 1 });
    const order = await service.createOrder(draft());
    expect(order).toBe(ORDER);
    expect(calls).toEqual(['order.create', 'wallet.updateMany']);
    // 성공 경로는 tx 밖 판별 SELECT를 호출하지 않는다
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
  });

  it('차감 조건부 where에 balance gte cost 포함 — 초과 인출 방지', async () => {
    const { service, tx } = makeService({ debitCount: 1 });
    await service.createOrder(draft({ cost: new Decimal(250) }));
    expect(tx.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ balance: { gte: new Decimal(250) } }),
        data: expect.objectContaining({
          balance: { decrement: new Decimal(250) },
          locked: { increment: new Decimal(250) },
        }),
      }),
    );
  });

  it('잔고 부족(차감 0건 + 지갑 존재): INSUFFICIENT_BALANCE, 주문 미확정(tx 롤백)', async () => {
    const { service, calls } = makeService({ debitCount: 0, walletExists: true });
    await expect(service.createOrder(draft())).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_BALANCE,
    });
    // 판별 SELECT는 락 tx 밖(마지막)에서만
    expect(calls).toEqual(['order.create', 'wallet.updateMany', 'wallet.findUnique']);
  });

  it('지갑 부재(차감 0건 + SELECT null): WALLET_NOT_FOUND', async () => {
    const { service } = makeService({ debitCount: 0, walletExists: false });
    await expect(service.createOrder(draft())).rejects.toMatchObject({
      code: ErrorCode.WALLET_NOT_FOUND,
    });
  });

  it('reduceOnly(cost 0): 잠금 없이 plain create — tx/차감 미경유', async () => {
    const { service, calls, tx } = makeService();
    const order = await service.createOrder(
      draft({ reduceOnly: true, cost: new Decimal(0) }),
    );
    expect(order).toBe(ORDER);
    expect(calls).toEqual(['plain.order.create']);
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('불변식: reduceOnly와 cost==0 불일치는 즉시 거부(무담보 주문 차단)', async () => {
    const { service } = makeService();
    await expect(
      service.createOrder(draft({ reduceOnly: true, cost: new Decimal(100) })),
    ).rejects.toThrow('order cost must be zero iff reduceOnly');
  });

  // ---------- ADR-069 S2 진실 스위치 ----------

  describe('LEDGER_TRUTH 경로 (reserve, Wallet 행 UPDATE 없음)', () => {
    const key = { userId: 'A', assetSymbol: 'USDT', marketType: MarketType.FUTURES };

    it('성공: reserve로 balance→locked 홀드, tx는 order+저널만, wallet.updateMany 미경유', async () => {
      const h = makeService({ truth: true });
      (h.ledger as LedgerService).apply(key, 200_00000000n, 0n);

      const order = await h.service.createOrder(draft({ cost: new Decimal(100) }));
      expect(order).toBe(ORDER);
      // 핫패스 tx는 order.create만 (Wallet 행 UPDATE 없음)
      expect(h.calls).toEqual(['order.create']);
      expect(h.tx.wallet.updateMany).not.toHaveBeenCalled();
      // 원장 홀드: 200 → 100 free / 100 locked
      expect((h.ledger as LedgerService).getScaled(key)).toEqual({
        balance: 100_00000000n,
        locked: 100_00000000n,
      });
    });

    it('잔고 부족: reserve false → INSUFFICIENT_BALANCE, tx 미진입', async () => {
      const h = makeService({ truth: true });
      (h.ledger as LedgerService).apply(key, 50_00000000n, 0n); // cost 100 필요

      await expect(
        h.service.createOrder(draft({ cost: new Decimal(100) })),
      ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_BALANCE });
      expect(h.calls).toEqual([]); // order.create도 안 함
      expect((h.ledger as LedgerService).getScaled(key)).toEqual({
        balance: 50_00000000n,
        locked: 0n,
      });
    });
  });
});
