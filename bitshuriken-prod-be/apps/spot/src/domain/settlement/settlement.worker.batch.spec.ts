import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { JournalWriter } from '@app/core-domain/ledger/journal-writer';
import { LedgerService } from '@app/core-domain/ledger/ledger.service';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';
import { UserStreamService } from '../user-stream/user-stream.service';
import { SettlementWorker, planBatch, debitKeysOf, walletKey } from './settlement.worker';

// S0 원장 섀도(박제): createManyInTx는 강등 no-op(false), ledger는 no-op 스텁.
function ledgerStubs() {
  return {
    journal: { createManyInTx: jest.fn().mockResolvedValue(false) } as unknown as JournalWriter,
    ledger: {
      owns: jest.fn().mockReturnValue(true),
      applyJournal: jest.fn(),
    } as unknown as LedgerService,
  };
}

// fast-path 배치 합산: 순수 planBatch/debitKeysOf 등가성 + applyBatch claim/제외/폴백 경로.

interface LegIn {
  userId?: string;
  assetSymbol?: string;
  marketType?: string;
  lockedDelta: string;
  balanceDelta: string;
}

// 순수 함수(planBatch/debitKeysOf)는 이제 parseWalletLegs가 1회 파싱한 구조체를 소비 —
// 헬퍼도 동일 규칙(lockedDec/balanceDec/creditOnly, executedDec/cumulativeDec)으로 구성.
function parsed(id: string, legs: LegIn[], orderLegs: Array<Record<string, string>> = []) {
  return {
    id,
    walletLegs: legs.map((l) => {
      const lockedDec = new Decimal(l.lockedDelta);
      const balanceDec = new Decimal(l.balanceDelta);
      return {
        userId: l.userId ?? 'A',
        assetSymbol: l.assetSymbol ?? 'BTC',
        marketType: (l.marketType ?? 'SPOT') as never,
        lockedDelta: l.lockedDelta,
        balanceDelta: l.balanceDelta,
        lockedDec,
        balanceDec,
        creditOnly: lockedDec.gte(0) && balanceDec.gte(0),
      };
    }),
    orderLegs: orderLegs.map((o) => ({
      orderId: o.orderId,
      executedQtyDelta: o.executedQtyDelta,
      cumulativeQuoteQtyDelta: o.cumulativeQuoteQtyDelta,
      executedDec: new Decimal(o.executedQtyDelta),
      cumulativeDec: new Decimal(o.cumulativeQuoteQtyDelta),
    })),
  };
}

describe('planBatch / debitKeysOf (순수 합산)', () => {
  it('debitKeysOf: 차감성 leg가 겨냥하는 키만(중복 제거), 순수 credit 키 제외', () => {
    const events = [
      parsed('e1', [{ lockedDelta: '0', balanceDelta: '0.5' }]), // credit-only USDT? no BTC
      parsed('e2', [{ lockedDelta: '-1', balanceDelta: '0' }]), // debit BTC
      parsed('e3', [{ assetSymbol: 'USDT', lockedDelta: '-5', balanceDelta: '5' }]), // debit USDT
      parsed('e4', [{ lockedDelta: '-2', balanceDelta: '0' }]), // debit BTC 다시(중복 키)
    ];
    const keys = debitKeysOf(events).map(walletKey).sort();
    expect(keys).toEqual(['A BTC SPOT', 'A USDT SPOT']);
  });

  it('credit/debit 혼재 합산 — increment 합 = 합 increment (Decimal)', () => {
    const events = [
      parsed('e1', [
        { lockedDelta: '0', balanceDelta: '0.5' }, // 매수자 수령(credit-only)
        { assetSymbol: 'USDT', lockedDelta: '-5000', balanceDelta: '0' }, // 매수자 quote 차감
      ]),
      parsed('e2', [{ lockedDelta: '0', balanceDelta: '0.25' }]), // 같은 키 credit 추가
    ];
    const plan = planBatch(events, new Set());
    expect(plan.appliedEventIds).toEqual(['e1', 'e2']);
    expect(plan.excludedEventIds).toEqual([]);

    const btc = plan.walletDeltas.find((w) => walletKey(w) === 'A BTC SPOT')!;
    const usdt = plan.walletDeltas.find((w) => walletKey(w) === 'A USDT SPOT')!;
    expect(btc.balance.toFixed()).toBe('0.75'); // 0.5 + 0.25
    expect(btc.hasDebit).toBe(false); // 순수 credit → upsert 자격
    expect(usdt.locked.toFixed()).toBe('-5000');
    expect(usdt.hasDebit).toBe(true); // 차감 포함 → update
  });

  it('Decimal 정밀도: 8자리 누적 합이 부동소수 오차 없이 정확', () => {
    const events = Array.from({ length: 3 }, (_, i) =>
      parsed(`e${i}`, [{ lockedDelta: '0', balanceDelta: '0.00000001' }]),
    );
    const plan = planBatch(events, new Set());
    expect(plan.walletDeltas[0].balance.toFixed()).toBe('0.00000003');
  });

  it('차감 대상 행 부재 → 그 이벤트만 제외, 나머지 재합산(제외분 PENDING 유지)', () => {
    const events = [
      parsed('e1', [{ lockedDelta: '-1', balanceDelta: '0' }]), // BTC 차감 — 행 부재
      parsed('e2', [{ assetSymbol: 'USDT', lockedDelta: '0', balanceDelta: '10' }]), // credit — 무관
    ];
    const absent = new Set(['A BTC SPOT']);
    const plan = planBatch(events, absent);
    expect(plan.excludedEventIds).toEqual(['e1']);
    expect(plan.appliedEventIds).toEqual(['e2']);
    expect(plan.walletDeltas.map(walletKey)).toEqual(['A USDT SPOT']);
  });

  it('행 부재 키에 credit-only leg만 있으면 제외하지 않음(upsert가 행 생성)', () => {
    const events = [parsed('e1', [{ lockedDelta: '0', balanceDelta: '1' }])];
    const plan = planBatch(events, new Set(['A BTC SPOT'])); // absent이지만 credit-only
    expect(plan.excludedEventIds).toEqual([]);
    expect(plan.appliedEventIds).toEqual(['e1']);
    expect(plan.walletDeltas[0].hasDebit).toBe(false);
  });

  it('order leg orderId별 합산', () => {
    const events = [
      parsed('e1', [{ lockedDelta: '0', balanceDelta: '1' }], [
        { orderId: 'o1', executedQtyDelta: '0.1', cumulativeQuoteQtyDelta: '5000' },
      ]),
      parsed('e2', [{ lockedDelta: '0', balanceDelta: '1' }], [
        { orderId: 'o1', executedQtyDelta: '0.2', cumulativeQuoteQtyDelta: '10000' },
      ]),
    ];
    const plan = planBatch(events, new Set());
    expect(plan.orderDeltas).toHaveLength(1);
    expect(plan.orderDeltas[0].orderId).toBe('o1');
    expect(plan.orderDeltas[0].executedQty.toFixed()).toBe('0.3');
    expect(plan.orderDeltas[0].cumulativeQuoteQty.toFixed()).toBe('15000');
  });
});

// ---------- applyBatch: claim 경합 / 제외 / 폴백 ----------

function evt(id: string, legs: LegIn[]) {
  return {
    id,
    seq: 1,
    sourceKey: `k-${id}`,
    kind: 'TRADE',
    legs: legs.map((l) => ({
      userId: l.userId ?? 'A',
      assetSymbol: l.assetSymbol ?? 'BTC',
      marketType: l.marketType ?? 'SPOT',
      lockedDelta: l.lockedDelta,
      balanceDelta: l.balanceDelta,
    })),
    orderLegs: [],
  };
}

class FakeTx {
  applied: string[] = [];
  updated: string[] = [];
  upserted: string[] = [];
  constructor(
    private lockedIds: string[],
    private existing: Set<string>,
    private throwOnSelect = false,
  ) {}

  $queryRaw = (): Promise<unknown[]> => {
    if (this.throwOnSelect) return Promise.reject(new Error('boom-select'));
    return Promise.resolve(this.lockedIds.map((id) => ({ id })));
  };
  settlementEvent = {
    updateMany: (args: { where: { id: { in: string[] } } }): Promise<{ count: number }> => {
      this.applied.push(...args.where.id.in);
      return Promise.resolve({ count: args.where.id.in.length });
    },
  };
  wallet = {
    findMany: (args: {
      where: { OR: Array<{ userId: string; assetSymbol: string; marketType: string }> };
    }): Promise<unknown[]> =>
      Promise.resolve(
        args.where.OR.filter((k) => this.existing.has(walletKey(k as never))).map((k) => ({ ...k })),
      ),
    update: (args: {
      where: { userId_assetSymbol_marketType: Record<string, string> };
    }): Promise<unknown> => {
      const k = args.where.userId_assetSymbol_marketType;
      this.updated.push(walletKey(k as never));
      return Promise.resolve({ ...k, balance: new Decimal(0), locked: new Decimal(0), updatedAt: new Date() });
    },
    upsert: (args: {
      where: { userId_assetSymbol_marketType: Record<string, string> };
    }): Promise<unknown> => {
      const k = args.where.userId_assetSymbol_marketType;
      this.upserted.push(walletKey(k as never));
      return Promise.resolve({ ...k, balance: new Decimal(0), locked: new Decimal(0), updatedAt: new Date() });
    },
  };
  order = { update: (): Promise<unknown> => Promise.resolve({}) };
}

function workerWith(tx: FakeTx) {
  const prisma = { $transaction: (fn: (t: FakeTx) => Promise<unknown>) => fn(tx) };
  const { journal, ledger } = ledgerStubs();
  const worker = new SettlementWorker(
    prisma as unknown as PrismaService,
    {} as UserStreamService,
    journal,
    ledger,
    { enabled: false } as unknown as LedgerAvailability, // S0 경로
  );
  return worker as unknown as {
    applyBatch: (events: unknown[]) => Promise<Map<string, unknown>>;
  };
}

describe('SettlementWorker.applyBatch (fast path)', () => {
  it('claim 경합: SELECT FOR UPDATE가 잠근 id만 APPLIED (이미 처리된 이벤트 skip)', async () => {
    const tx = new FakeTx(['e1'], new Set(['A BTC SPOT'])); // e2는 잠금 실패로 제외
    const worker = workerWith(tx);
    await worker.applyBatch([
      evt('e1', [{ lockedDelta: '-1', balanceDelta: '0' }]),
      evt('e2', [{ lockedDelta: '-1', balanceDelta: '0' }]),
    ]);
    expect(tx.applied).toEqual(['e1']);
    expect(tx.updated).toEqual(['A BTC SPOT']); // e1의 차감 update 1회
  });

  it('차감 대상 행 부재: 그 이벤트 제외 → claim/적용에서 빠지고 PENDING 유지', async () => {
    const tx = new FakeTx(['e1'], new Set()); // BTC 행 없음
    const worker = workerWith(tx);
    await worker.applyBatch([evt('e1', [{ lockedDelta: '-1', balanceDelta: '0' }])]);
    expect(tx.applied).toEqual([]); // 적용분 0 → claim 안 함
    expect(tx.updated).toEqual([]);
  });

  it('순수 credit 키는 upsert, 차감 포함 키는 update', async () => {
    const tx = new FakeTx(['e1'], new Set(['A USDT SPOT']));
    const worker = workerWith(tx);
    await worker.applyBatch([
      evt('e1', [
        { lockedDelta: '0', balanceDelta: '0.5' }, // BTC credit-only → upsert
        { assetSymbol: 'USDT', lockedDelta: '-5000', balanceDelta: '0' }, // USDT 차감 → update
      ]),
    ]);
    expect(tx.applied).toEqual(['e1']);
    expect(tx.upserted).toEqual(['A BTC SPOT']);
    expect(tx.updated).toEqual(['A USDT SPOT']);
  });

  it('fast path throw → 위로 전파(drain이 per-event 폴백하도록)', async () => {
    const tx = new FakeTx(['e1'], new Set(['A BTC SPOT']), true); // SELECT throw
    const worker = workerWith(tx);
    await expect(
      worker.applyBatch([evt('e1', [{ lockedDelta: '-1', balanceDelta: '0' }])]),
    ).rejects.toThrow('boom-select');
  });
});

describe('SettlementWorker.applyBatch — parse-once 등가성', () => {
  it('leg 델타를 1회 파싱해 wallet 라우팅·저널 델타에 동일 Decimal을 전파', async () => {
    const tx = new FakeTx(['e1'], new Set(['A USDT SPOT'])); // USDT 행 존재(차감 대상)
    const journal = { createManyInTx: jest.fn().mockResolvedValue(false) } as unknown as JournalWriter;
    const ledger = {
      owns: jest.fn().mockReturnValue(true),
      applyJournal: jest.fn(),
    } as unknown as LedgerService;
    const prisma = { $transaction: (fn: (t: FakeTx) => Promise<unknown>) => fn(tx) };
    const worker = new SettlementWorker(
      prisma as unknown as PrismaService,
      {} as UserStreamService,
      journal,
      ledger,
      { enabled: false } as unknown as LedgerAvailability, // S0 경로
    ) as unknown as { applyBatch: (e: unknown[]) => Promise<Map<string, unknown>> };

    await worker.applyBatch([
      evt('e1', [
        { lockedDelta: '0', balanceDelta: '0.00000003' }, // BTC 순수 credit → upsert
        { assetSymbol: 'USDT', lockedDelta: '-5000', balanceDelta: '0' }, // USDT 차감 → update
      ]),
    ]);

    // 저널 델타 = leg 문자열과 정확히 일치 (재파싱 없이 파싱된 Decimal 전파)
    const inputs = (journal.createManyInTx as jest.Mock).mock.calls[0][1] as Array<{
      assetSymbol: string;
      deltaBalance: Decimal;
      deltaLocked: Decimal;
    }>;
    const btc = inputs.find((i) => i.assetSymbol === 'BTC')!;
    const usdt = inputs.find((i) => i.assetSymbol === 'USDT')!;
    expect(btc.deltaBalance.toFixed()).toBe('0.00000003');
    expect(btc.deltaLocked.toFixed()).toBe('0');
    expect(usdt.deltaLocked.toFixed()).toBe('-5000');
    expect(usdt.deltaBalance.toFixed()).toBe('0');

    // creditOnly 판정도 동일 파싱에서 파생 — credit=upsert, debit=update
    expect(tx.upserted).toEqual(['A BTC SPOT']);
    expect(tx.updated).toEqual(['A USDT SPOT']);
  });
});

describe('SettlementWorker.drain — 폴백', () => {
  it('applyBatch 실패 시 applyPerEvent로 폴백(recordFailure 시맨틱 보존 경로)', async () => {
    const pending = [evt('e1', [{ lockedDelta: '-1', balanceDelta: '0' }])];
    const prisma = {
      settlementEvent: { findMany: jest.fn().mockResolvedValue(pending) },
    };
    const { journal, ledger } = ledgerStubs();
    const worker = new SettlementWorker(
      prisma as unknown as PrismaService,
      { emitAccountPosition: jest.fn() } as unknown as UserStreamService,
      journal,
      ledger,
      { enabled: false } as unknown as LedgerAvailability, // S0 경로
    );
    const w = worker as unknown as {
      drain: () => Promise<void>;
      applyBatch: (e: unknown[]) => Promise<Map<string, unknown>>;
      applyPerEvent: (e: unknown[]) => Promise<Map<string, unknown>>;
    };
    const batchSpy = jest.spyOn(w, 'applyBatch').mockRejectedValue(new Error('boom'));
    const perEventSpy = jest.spyOn(w, 'applyPerEvent').mockResolvedValue(new Map());

    await w.drain();

    expect(batchSpy).toHaveBeenCalledWith(pending);
    expect(perEventSpy).toHaveBeenCalledWith(pending);
  });
});
