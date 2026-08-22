import { MarketType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { KafkaService } from '@app/infra/messaging/kafka.service';
import { JournalWriter } from '@app/core-domain/ledger/journal-writer';
import { LedgerService } from '@app/core-domain/ledger/ledger.service';
import { FuturesConfigService } from '../config/futures-config.service';
import { MarkPriceService } from '../mark-price/mark-price.service';
import { FuturesUserEventsService } from '../user-events/futures-user-events.service';
import { InsuranceFundService } from './insurance-fund.service';
import { FuturesSettlementWorker } from './futures-settlement.worker';

// 정산 상태기계 가드레일 — in-memory fake Prisma로 worker의 전이/보존 법칙을 검증한다.

const d = (v: string | number) => new Decimal(v);
const SYM = 'BTCUSDT';
const FUND = 'fund-user';

interface EventRow {
  id: string;
  seq: number;
  sourceKey: string;
  kind: string;
  legs: unknown[];
  orderLegs: unknown[];
  status: string;
  createdAt: Date;
  appliedAt: Date | null;
}

interface OrderRow {
  id: string;
  userId: string;
  tickerSymbol: string;
  tickerMarket: string;
  type: string;
  side: string;
  timeInForce: string;
  price: Decimal | null;
  origQty: Decimal;
  origQuoteQty: Decimal | null;
  executedQty: Decimal;
  cumulativeQuoteQty: Decimal;
  status: string;
  reduceOnly: boolean;
  liquidation: boolean;
  lockedCost: Decimal | null;
  orderListId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PositionRow {
  userId: string;
  tickerSymbol: string;
  tickerMarket: string;
  qty: Decimal;
  entryPrice: Decimal;
  isolatedMargin: Decimal;
  leverage: number;
  status: string;
  updatedAt: Date;
}

interface WalletRow {
  userId: string;
  assetSymbol: string;
  marketType: string;
  balance: Decimal;
  locked: Decimal;
  updatedAt: Date;
}

interface IncomeRow {
  userId: string;
  tickerSymbol: string | null;
  incomeType: string;
  income: Decimal;
  sourceKey: string;
}

function applyData(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Decimal) && !(v instanceof Date)) {
      const op = v as { increment?: Decimal; decrement?: Decimal };
      if (op.increment !== undefined) row[k] = (row[k] as Decimal).add(op.increment);
      else if (op.decrement !== undefined) row[k] = (row[k] as Decimal).sub(op.decrement);
      else row[k] = v;
    } else {
      row[k] = v;
    }
  }
  row.updatedAt = new Date();
}

class FakePrisma {
  events: EventRow[] = [];
  orders = new Map<string, OrderRow>();
  positions = new Map<string, PositionRow>(); // `${userId}:${symbol}`
  wallets = new Map<string, WalletRow>(); // userId (USDT/FUTURES 고정)
  incomes: IncomeRow[] = [];
  private seq = 0;

  settlementEvent = {
    findMany: (args: {
      where: { status: string; kind: { in: string[] } };
      orderBy?: { seq?: string } | unknown[];
      take: number;
    }) => {
      // worker가 넘긴 orderBy를 따른다 — seq가 아니면 createdAt (정렬 계약 회귀 검출용)
      const bySeq = !Array.isArray(args.orderBy) && args.orderBy?.seq === 'asc';
      const rows = this.events
        .filter((e) => e.status === args.where.status && args.where.kind.in.includes(e.kind))
        .sort(
          bySeq
            ? (a, b) => a.seq - b.seq
            : (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq,
        )
        .slice(0, args.take);
      return Promise.resolve(rows);
    },
    updateMany: (args: {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    }) => {
      const row = this.events.find((e) => e.id === args.where.id && e.status === args.where.status);
      if (!row) return Promise.resolve({ count: 0 });
      Object.assign(row, args.data);
      return Promise.resolve({ count: 1 });
    },
    create: (args: {
      data: { sourceKey: string; kind: string; legs: unknown; orderLegs: unknown };
    }) => {
      if (this.events.some((e) => e.sourceKey === args.data.sourceKey)) {
        return Promise.reject(new Error(`duplicate sourceKey ${args.data.sourceKey}`));
      }
      const row: EventRow = {
        id: `evt-${String(++this.seq).padStart(6, '0')}`,
        seq: this.seq,
        sourceKey: args.data.sourceKey,
        kind: args.data.kind,
        legs: args.data.legs as unknown[],
        orderLegs: args.data.orderLegs as unknown[],
        status: 'PENDING',
        createdAt: new Date(this.seq),
        appliedAt: null,
      };
      this.events.push(row);
      return Promise.resolve(row);
    },
  };

  order = {
    findUnique: (args: { where: { id: string } }) =>
      Promise.resolve(this.orders.get(args.where.id) ?? null),
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.orders.get(args.where.id);
      if (!row) return Promise.reject(new Error(`order ${args.where.id} not found`));
      applyData(row as unknown as Record<string, unknown>, args.data);
      return Promise.resolve(row);
    },
    findMany: (args: {
      where: {
        userId: string;
        tickerSymbol: string;
        reduceOnly: boolean;
        status: { in: string[] };
      };
    }) => {
      const rows = [...this.orders.values()]
        .filter(
          (o) =>
            o.userId === args.where.userId &&
            o.tickerSymbol === args.where.tickerSymbol &&
            o.reduceOnly === args.where.reduceOnly &&
            args.where.status.in.includes(o.status),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return Promise.resolve(rows);
    },
  };

  position = {
    findUnique: (args: {
      where: { userId_tickerSymbol: { userId: string; tickerSymbol: string } };
    }) => {
      const { userId, tickerSymbol } = args.where.userId_tickerSymbol;
      return Promise.resolve(this.positions.get(`${userId}:${tickerSymbol}`) ?? null);
    },
    update: (args: {
      where: { userId_tickerSymbol: { userId: string; tickerSymbol: string } };
      data: Record<string, unknown>;
    }) => {
      const { userId, tickerSymbol } = args.where.userId_tickerSymbol;
      const row = this.positions.get(`${userId}:${tickerSymbol}`);
      if (!row) return Promise.reject(new Error(`position ${userId}/${tickerSymbol} not found`));
      applyData(row as unknown as Record<string, unknown>, args.data);
      return Promise.resolve(row);
    },
  };

  wallet = {
    update: (args: {
      where: { userId_assetSymbol_marketType: { userId: string } };
      data: Record<string, unknown>;
    }) => {
      const row = this.wallets.get(args.where.userId_assetSymbol_marketType.userId);
      if (!row) {
        return Promise.reject(
          new Error(`wallet ${args.where.userId_assetSymbol_marketType.userId} not found`),
        );
      }
      applyData(row as unknown as Record<string, unknown>, args.data);
      return Promise.resolve(row);
    },
  };

  futuresIncome = {
    create: (args: { data: IncomeRow }) => {
      if (this.incomes.some((i) => i.sourceKey === args.data.sourceKey)) {
        return Promise.reject(new Error(`duplicate income sourceKey ${args.data.sourceKey}`));
      }
      this.incomes.push({ ...args.data });
      return Promise.resolve(args.data);
    },
  };

  // ADR-069 S0: 저널 append-only 테이블 fake — sourceKey @unique 미러(중복 거부).
  journals: { sourceKey: string }[] = [];
  balanceJournal = {
    create: (args: { data: { sourceKey: string } & Record<string, unknown> }) => {
      if (this.journals.some((j) => j.sourceKey === args.data.sourceKey)) {
        return Promise.reject(new Error(`duplicate journal sourceKey ${args.data.sourceKey}`));
      }
      const row = { id: `bj-${++this.seq}`, seq: this.seq, createdAt: new Date(), ...args.data };
      this.journals.push(row as never);
      return Promise.resolve(row);
    },
  };

  ticker = {
    findUnique: () => Promise.resolve({ partition: 0 }),
  };

  $transaction(fn: (tx: this) => Promise<void>): Promise<void> {
    return fn(this);
  }

  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const sql = strings.join('?');
    if (sql.includes('INSERT INTO "Position"')) {
      const [userId, symbol] = values as [string, string];
      const key = `${userId}:${symbol}`;
      if (!this.positions.has(key)) {
        this.positions.set(key, {
          userId,
          tickerSymbol: symbol,
          tickerMarket: 'FUTURES',
          qty: d(0),
          entryPrice: d(0),
          isolatedMargin: d(0),
          leverage: 10,
          status: 'NORMAL',
          updatedAt: new Date(),
        });
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    }
    return Promise.reject(new Error(`unexpected $executeRaw: ${sql}`));
  }

  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const sql = strings.join('?');
    if (sql.includes('FROM "Position"')) {
      const [userId, symbol] = values as [string, string];
      const row = this.positions.get(`${userId}:${symbol}`);
      return Promise.resolve(row ? [{ ...row }] : []);
    }
    if (sql.includes('FROM "Wallet"')) {
      const [userId] = values as [string];
      const row = this.wallets.get(userId);
      return Promise.resolve(row ? [{ balance: row.balance, locked: row.locked }] : []);
    }
    return Promise.reject(new Error(`unexpected $queryRaw: ${sql}`));
  }

  // ---- seed helpers ----

  seedWallet(userId: string, balance: string | number, locked: string | number = 0): void {
    this.wallets.set(userId, {
      userId,
      assetSymbol: 'USDT',
      marketType: 'FUTURES',
      balance: d(balance),
      locked: d(locked),
      updatedAt: new Date(),
    });
  }

  seedPosition(
    userId: string,
    qty: string | number,
    entryPrice: string | number,
    isolatedMargin: string | number,
    over: Partial<PositionRow> = {},
  ): void {
    this.positions.set(`${userId}:${SYM}`, {
      userId,
      tickerSymbol: SYM,
      tickerMarket: 'FUTURES',
      qty: d(qty),
      entryPrice: d(entryPrice),
      isolatedMargin: d(isolatedMargin),
      leverage: 10,
      status: 'NORMAL',
      updatedAt: new Date(),
      ...over,
    });
  }

  seedOrder(over: Partial<OrderRow> & { id: string; userId: string }): void {
    this.orders.set(over.id, {
      tickerSymbol: SYM,
      tickerMarket: 'FUTURES',
      type: 'LIMIT',
      side: 'BUY',
      timeInForce: 'GTC',
      price: null,
      origQty: d(1),
      origQuoteQty: null,
      executedQty: d(0),
      cumulativeQuoteQty: d(0),
      status: 'OPEN',
      reduceOnly: false,
      liquidation: false,
      lockedCost: null,
      orderListId: null,
      createdAt: new Date(++this.seq),
      updatedAt: new Date(),
      ...over,
    });
  }

  seedTradeEvent(args: {
    tid: string;
    price: string | number;
    qty: string | number;
    makerOrderId: string;
    makerUserId: string;
    takerOrderId: string;
    takerUserId: string;
    takerSide: 'BUY' | 'SELL';
    feeBps?: number;
  }): void {
    const quote = d(args.price).mul(args.qty).toString();
    void this.settlementEvent.create({
      data: {
        sourceKey: args.tid,
        kind: 'FUTURES_TRADE',
        legs: [
          {
            symbol: SYM,
            price: d(args.price).toString(),
            qty: d(args.qty).toString(),
            makerOrderId: args.makerOrderId,
            makerUserId: args.makerUserId,
            takerOrderId: args.takerOrderId,
            takerUserId: args.takerUserId,
            takerSide: args.takerSide,
            makerFeeBps: args.feeBps ?? 5,
            takerFeeBps: args.feeBps ?? 5,
          },
        ],
        orderLegs: [
          {
            orderId: args.makerOrderId,
            executedQtyDelta: d(args.qty).toString(),
            cumulativeQuoteQtyDelta: quote,
          },
          {
            orderId: args.takerOrderId,
            executedQtyDelta: d(args.qty).toString(),
            cumulativeQuoteQtyDelta: quote,
          },
        ],
      },
    });
  }

  seedEvent(kind: string, sourceKey: string, legs: Record<string, unknown>[]): void {
    void this.settlementEvent.create({ data: { sourceKey, kind, legs, orderLegs: [] } });
  }

  sumPositionQty(): Decimal {
    let sum = d(0);
    for (const p of this.positions.values()) sum = sum.add(p.qty);
    return sum;
  }

  /** mark 기준 시스템 총자산 = Σ(balance+locked) + Σmargin + Σ(mark−EP)×qty — 보존 법칙 검증용. */
  totalWealth(mark: Decimal): Decimal {
    let total = d(0);
    for (const w of this.wallets.values()) total = total.add(w.balance).add(w.locked);
    for (const p of this.positions.values()) {
      total = total.add(p.isolatedMargin).add(mark.sub(p.entryPrice).mul(p.qty));
    }
    return total;
  }
}

function makeWorker(db: FakePrisma, opts: { truth?: boolean } = {}) {
  const kafka = { emit: jest.fn().mockResolvedValue(undefined) };
  const config = {
    configOf: jest.fn().mockResolvedValue({ liquidationFeeRate: d('0.005'), mmr: d('0.005') }),
  };
  const fund = { userId: jest.fn().mockResolvedValue(FUND) };
  const userEvents = new FuturesUserEventsService();
  // mark 미형성 — positionUpdate 파생값(mark/UPNL/청산가)은 null로 남김(기존 자산/포지션 assertion 불변)
  const markPrice = { tryGetMark: jest.fn(() => null) };
  // 실 JournalWriter/LedgerService 주입 — writeInTx는 db.balanceJournal fake로, applyJournal은 인메모리.
  // availability는 enabled 스텁(테이블 존재 = 정상). LedgerAvailability 프로브 경로는 F 소유라 미모킹.
  const availability = { enabled: true };
  const journalWriter = new JournalWriter(db as unknown as PrismaService, availability as never);
  const ledger = new LedgerService([MarketType.FUTURES]);
  // 기존 박제는 S0(Wallet 행 회계) 검증 — 워커 availability는 disabled로 진실 스위치 OFF 고정.
  // (journalWriter는 enabled라 저널·원장 섀도 반영은 계속 일어나 ledger assertion도 유효.)
  // opts.truth=true면 워커도 진실 스위치 ON.
  const workerAvailability = { enabled: opts.truth ?? false };
  const worker = new FuturesSettlementWorker(
    db as unknown as PrismaService,
    kafka as unknown as KafkaService,
    config as unknown as FuturesConfigService,
    fund as unknown as InsuranceFundService,
    userEvents,
    markPrice as unknown as MarkPriceService,
    journalWriter,
    ledger,
    workerAvailability as never,
  );
  return { worker, kafka, userEvents, ledger, db };
}

describe('FuturesSettlementWorker', () => {
  it('FUTURES_TRADE: 양측 신규 진입 — 마진/수수료/잠금 해제, sum(qty)==0', async () => {
    const db = new FakePrisma();
    // lockedCost = IM 5000 + openLoss 0 + fee 예약 25
    db.seedOrder({
      id: 'oA',
      userId: 'A',
      side: 'BUY',
      price: d(50000),
      origQty: d(1),
      lockedCost: d(5025),
    });
    db.seedOrder({
      id: 'oB',
      userId: 'B',
      side: 'SELL',
      price: d(50000),
      origQty: d(1),
      lockedCost: d(5025),
    });
    db.seedWallet('A', 1000, 5025);
    db.seedWallet('B', 2000, 5025);
    db.seedTradeEvent({
      tid: 't1',
      price: 50000,
      qty: 1,
      makerOrderId: 'oB',
      makerUserId: 'B',
      takerOrderId: 'oA',
      takerUserId: 'A',
      takerSide: 'BUY',
    });

    const { worker } = makeWorker(db);
    await worker.tick();

    const posA = db.positions.get(`A:${SYM}`)!;
    const posB = db.positions.get(`B:${SYM}`)!;
    expect(posA.qty.toFixed()).toBe('1');
    expect(posA.entryPrice.toFixed()).toBe('50000');
    expect(posA.isolatedMargin.toFixed()).toBe('5000');
    expect(posB.qty.toFixed()).toBe('-1');
    expect(db.sumPositionQty().toFixed()).toBe('0');

    // release 5025 − marginAdd 5000 − fee 25 = 0
    const wA = db.wallets.get('A')!;
    expect(wA.locked.toFixed()).toBe('0');
    expect(wA.balance.toFixed()).toBe('1000');

    const oA = db.orders.get('oA')!;
    expect(oA.executedQty.toFixed()).toBe('1');
    expect(oA.cumulativeQuoteQty.toFixed()).toBe('50000');

    const commissions = db.incomes.filter((i) => i.incomeType === 'COMMISSION');
    expect(commissions).toHaveLength(2);
    expect(commissions[0].income.toFixed()).toBe('-25');
    expect(db.events[0].status).toBe('APPLIED');
  });

  it('multi-fill: 두 번째 fill이 첫 fill이 만든 EP 기준으로 가중평균된다', async () => {
    const db = new FakePrisma();
    db.seedOrder({
      id: 'oA',
      userId: 'A',
      side: 'BUY',
      price: d(51000),
      origQty: d(2),
      lockedCost: d(10110),
    });
    db.seedOrder({
      id: 'oB',
      userId: 'B',
      side: 'SELL',
      price: d(50000),
      origQty: d(1),
      lockedCost: d(0),
    });
    db.seedOrder({
      id: 'oC',
      userId: 'C',
      side: 'SELL',
      price: d(51000),
      origQty: d(1),
      lockedCost: d(0),
    });
    db.seedWallet('A', 10000, 10110);
    db.seedWallet('B', 50000);
    db.seedWallet('C', 50000);
    db.seedTradeEvent({
      tid: 't1',
      price: 50000,
      qty: 1,
      makerOrderId: 'oB',
      makerUserId: 'B',
      takerOrderId: 'oA',
      takerUserId: 'A',
      takerSide: 'BUY',
    });
    db.seedTradeEvent({
      tid: 't2',
      price: 51000,
      qty: 1,
      makerOrderId: 'oC',
      makerUserId: 'C',
      takerOrderId: 'oA',
      takerUserId: 'A',
      takerSide: 'BUY',
    });

    const { worker } = makeWorker(db);
    await worker.tick();

    const posA = db.positions.get(`A:${SYM}`)!;
    expect(posA.qty.toFixed()).toBe('2');
    expect(posA.entryPrice.toFixed()).toBe('50500'); // (50000 + 51000)/2
    expect(posA.isolatedMargin.toFixed()).toBe('10100'); // 5000 + 5100

    // 전량 체결 — telescoping으로 locked 0
    const wA = db.wallets.get('A')!;
    expect(wA.locked.toFixed()).toBe('0');
    // +30 (release 5055 − 5000 − 25), −70.5 (release 5055 − 5100 − 25.5)
    expect(wA.balance.toFixed()).toBe('9959.5');
    expect(db.sumPositionQty().toFixed()).toBe('0');
  });

  it('감량 왕복: 전량 close 시 margin 전부 해제 + RPNL 실현, locked 잔존 0', async () => {
    const db = new FakePrisma();
    db.seedPosition('A', 1, 50000, 5000);
    db.seedPosition('B', -1, 50000, 5000);
    db.seedOrder({
      id: 'oA',
      userId: 'A',
      side: 'SELL',
      type: 'MARKET',
      timeInForce: 'IOC',
      origQty: d(1),
      reduceOnly: true,
      lockedCost: null,
    });
    db.seedOrder({
      id: 'oB',
      userId: 'B',
      side: 'BUY',
      price: d(52000),
      origQty: d(1),
      reduceOnly: true,
      lockedCost: null,
    });
    db.seedWallet('A', 100);
    db.seedWallet('B', 100);
    db.seedTradeEvent({
      tid: 't1',
      price: 52000,
      qty: 1,
      makerOrderId: 'oB',
      makerUserId: 'B',
      takerOrderId: 'oA',
      takerUserId: 'A',
      takerSide: 'SELL',
    });

    const { worker } = makeWorker(db);
    await worker.tick();

    const posA = db.positions.get(`A:${SYM}`)!;
    expect(posA.qty.toFixed()).toBe('0');
    expect(posA.entryPrice.toFixed()).toBe('0');
    expect(posA.isolatedMargin.toFixed()).toBe('0');

    // marginRelease 5000 + RPNL 2000 − fee 26
    const wA = db.wallets.get('A')!;
    expect(wA.balance.toFixed()).toBe('7074');
    expect(wA.locked.toFixed()).toBe('0');

    const rpnlA = db.incomes.find((i) => i.userId === 'A' && i.incomeType === 'REALIZED_PNL')!;
    expect(rpnlA.income.toFixed()).toBe('2000');
    // B(숏)는 거울 손실: marginRelease 5000 − RPNL 2000 − fee 26
    const wB = db.wallets.get('B')!;
    expect(wB.balance.toFixed()).toBe('3074');
    expect(db.sumPositionQty().toFixed()).toBe('0');
  });

  it('FUTURES_REFUND: 부분 체결 후 취소 — Σrelease+refund == lockedCost, locked 0', async () => {
    const db = new FakePrisma();
    db.seedOrder({
      id: 'oA',
      userId: 'A',
      side: 'BUY',
      price: d(50000),
      origQty: d(1),
      lockedCost: d(100),
    });
    db.seedOrder({
      id: 'oB',
      userId: 'B',
      side: 'SELL',
      price: d(50000),
      origQty: d('0.3'),
      lockedCost: d(0),
    });
    db.seedWallet('A', 5000, 100);
    db.seedWallet('B', 50000);
    db.seedTradeEvent({
      tid: 't1',
      price: 50000,
      qty: '0.3',
      makerOrderId: 'oB',
      makerUserId: 'B',
      takerOrderId: 'oA',
      takerUserId: 'A',
      takerSide: 'BUY',
    });
    db.seedEvent('FUTURES_REFUND', 'frefund:oA', [
      { orderId: 'oA', userId: 'A', finalExecutedQty: '0.3' },
    ]);

    const { worker } = makeWorker(db);
    await worker.tick();

    const wA = db.wallets.get('A')!;
    expect(wA.locked.toFixed()).toBe('0'); // release 30 + refund 70 == lockedCost 100
    expect(db.events.every((e) => e.status === 'APPLIED')).toBe(true);
  });

  it('FUNDING: zero-sum + balance 부족분은 margin 폭포', async () => {
    const db = new FakePrisma();
    db.seedPosition('A', 1, 50000, 500);
    db.seedPosition('B', -1, 50000, 500);
    db.seedWallet('A', 2); // payment −5 → balance 0, margin −3
    db.seedWallet('B', 100);
    db.seedEvent('FUNDING', `funding:${SYM}:1:A`, [
      { userId: 'A', symbol: SYM, rate: '0.0001', mark: '50000', qty: '1' },
    ]);
    db.seedEvent('FUNDING', `funding:${SYM}:1:B`, [
      { userId: 'B', symbol: SYM, rate: '0.0001', mark: '50000', qty: '-1' },
    ]);

    const { worker } = makeWorker(db);
    await worker.tick();

    const wA = db.wallets.get('A')!;
    const wB = db.wallets.get('B')!;
    expect(wA.balance.toFixed()).toBe('0');
    expect(db.positions.get(`A:${SYM}`)!.isolatedMargin.toFixed()).toBe('497');
    expect(wB.balance.toFixed()).toBe('105');

    const fees = db.incomes.filter((i) => i.incomeType === 'FUNDING_FEE');
    expect(fees.map((f) => f.income.toFixed()).sort()).toEqual(['-5', '5']);
    // zero-sum: 지불 5 == 수령 5
    expect(fees.reduce((s, f) => s.add(f.income), d(0)).toFixed()).toBe('0');
  });

  it('LIQUIDATION_TAKEOVER(모니터): BP 인수 + margin 기금 귀속 + NORMAL 복귀', async () => {
    const db = new FakePrisma();
    db.seedPosition('A', -1, 50000, 100, { status: 'LIQUIDATING' });
    db.seedPosition('X', 1, 50000, 5000); // A 숏의 원래 반대편 — sum(qty)==0 검증용
    db.seedWallet('A', 0);
    db.seedWallet(FUND, 0);
    db.seedEvent('LIQUIDATION_TAKEOVER', 'ftk:A:1', [{ userId: 'A', symbol: SYM }]);

    const { worker } = makeWorker(db);
    await worker.tick();

    const posA = db.positions.get(`A:${SYM}`)!;
    expect(posA.qty.toFixed()).toBe('0');
    expect(posA.isolatedMargin.toFixed()).toBe('0');
    expect(posA.status).toBe('NORMAL');

    const fundPos = db.positions.get(`${FUND}:${SYM}`)!;
    expect(fundPos.qty.toFixed()).toBe('-1');
    expect(fundPos.entryPrice.toFixed()).toBe('50100'); // 숏 BP = EP + margin/Q

    expect(db.wallets.get(FUND)!.balance.toFixed()).toBe('100');
    const clear = db.incomes.find((i) => i.incomeType === 'INSURANCE_CLEAR')!;
    expect(clear.userId).toBe(FUND);
    expect(clear.income.toFixed()).toBe('100');
    expect(db.sumPositionQty().toFixed()).toBe('0');
  });

  it('takeover 상쇄: 기금 보유와 반대 부호 인수 시 netted RPNL이 기금 balance에 실현된다', async () => {
    const db = new FakePrisma();
    // 기금 롱 +10@100 보유 중 숏 −10을 BP 90으로 인수 → 전량 상쇄, RPNL (90−100)×10 = −100
    db.seedPosition(FUND, 10, 100, 0);
    db.seedPosition('A', -10, 90, 0, { status: 'LIQUIDATING' });
    db.seedWallet('A', 0);
    db.seedWallet(FUND, 0);
    db.seedEvent('LIQUIDATION_TAKEOVER', 'ftk:A:net', [{ userId: 'A', symbol: SYM }]);
    const before = db.totalWealth(d(95));

    const { worker } = makeWorker(db);
    await worker.tick();

    const fundPos = db.positions.get(`${FUND}:${SYM}`)!;
    expect(fundPos.qty.toFixed()).toBe('0');
    expect(fundPos.entryPrice.toFixed()).toBe('0');

    // 상쇄 손실이 기금 balance에 가시화 — 장부에서 증발하지 않는다
    expect(db.wallets.get(FUND)!.balance.toFixed()).toBe('-100');
    const netting = db.incomes.find((i) => i.sourceKey === 'ftk:A:net:fund:netting')!;
    expect(netting.incomeType).toBe('INSURANCE_CLEAR');
    expect(netting.income.toFixed()).toBe('-100');

    // 시스템 총액 불변 (임의 mark 기준)
    expect(db.totalWealth(d(95)).toFixed()).toBe(before.toFixed());
    expect(db.sumPositionQty().toFixed()).toBe('0');
    expect(db.positions.get(`A:${SYM}`)!.status).toBe('NORMAL');
  });

  it('flip 인수 부분 상쇄: netted 계약의 RPNL 실현, 잔여는 기존 EP 유지', async () => {
    const db = new FakePrisma();
    // 기금 롱 +10@100에 flip 인수 −4@90 → 잔여 +6@100, RPNL (90−100)×4 = −40
    db.seedPosition(FUND, 10, 100, 0);
    db.seedWallet(FUND, 0);
    db.seedEvent('LIQUIDATION_TAKEOVER', 'ftk2', [
      { userId: 'B', symbol: SYM, qty: '-4', entryPrice: '90', margin: '8' },
    ]);

    const { worker } = makeWorker(db);
    await worker.tick();

    const fundPos = db.positions.get(`${FUND}:${SYM}`)!;
    expect(fundPos.qty.toFixed()).toBe('6');
    expect(fundPos.entryPrice.toFixed()).toBe('100');
    expect(fundPos.isolatedMargin.toFixed()).toBe('8');

    expect(db.wallets.get(FUND)!.balance.toFixed()).toBe('-40');
    const incomes = db.incomes.filter((i) => i.incomeType === 'INSURANCE_CLEAR');
    expect(incomes.map((i) => i.income.toFixed()).sort()).toEqual(['-40', '8']);
  });

  it('flip IM 부족: LIQUIDATION_TAKEOVER 생산 → 다음 tick에 기금이 신규분 인수', async () => {
    const db = new FakePrisma();
    db.seedPosition('A', 1, 50000, 10);
    db.seedOrder({
      id: 'oA',
      userId: 'A',
      side: 'SELL',
      price: d(40000),
      origQty: d(2),
      lockedCost: d(0),
    });
    db.seedOrder({
      id: 'oB',
      userId: 'B',
      side: 'BUY',
      price: d(40000),
      origQty: d(2),
      lockedCost: d(16040),
    });
    db.seedWallet('A', 0);
    db.seedWallet('B', 0, 16040);
    db.seedWallet(FUND, 0);
    db.seedTradeEvent({
      tid: 't1',
      price: 40000,
      qty: 2,
      makerOrderId: 'oB',
      makerUserId: 'B',
      takerOrderId: 'oA',
      takerUserId: 'A',
      takerSide: 'SELL',
    });

    const { worker } = makeWorker(db);
    await worker.tick(); // trade apply — A는 flat 반환 + takeover 이벤트 생산

    const posA = db.positions.get(`A:${SYM}`)!;
    expect(posA.qty.toFixed()).toBe('0');
    const takeover = db.events.find((e) => e.kind === 'LIQUIDATION_TAKEOVER');
    expect(takeover).toBeDefined();
    expect(takeover!.status).toBe('PENDING');

    await worker.tick(); // takeover apply

    const fundPos = db.positions.get(`${FUND}:${SYM}`)!;
    expect(fundPos.qty.toFixed()).toBe('-1');
    expect(fundPos.entryPrice.toFixed()).toBe('40000');
    // B(+2) + fund(−1) + A(0) − 시드된 A 롱 1의 가상 반대편(−1) == 0
    expect(db.sumPositionQty().sub(1).toFixed()).toBe('0');
  });

  it('reduceOnly 초과분: 포지션 감소 후 최신 주문부터 CO 발행', async () => {
    const db = new FakePrisma();
    db.seedPosition('A', 2, 50000, 10000);
    db.seedOrder({
      id: 'oR1',
      userId: 'A',
      side: 'SELL',
      price: d(50000),
      origQty: d(1),
      reduceOnly: true,
    });
    db.seedOrder({
      id: 'oB',
      userId: 'B',
      side: 'BUY',
      price: d(50000),
      origQty: d(1),
      lockedCost: d(5025),
    });
    db.seedOrder({
      id: 'oR2',
      userId: 'A',
      side: 'SELL',
      price: d(55000),
      origQty: d('1.5'),
      reduceOnly: true,
    });
    db.seedWallet('A', 1000);
    db.seedWallet('B', 1000, 5025);
    db.seedTradeEvent({
      tid: 't1',
      price: 50000,
      qty: 1,
      makerOrderId: 'oB',
      makerUserId: 'B',
      takerOrderId: 'oR1',
      takerUserId: 'A',
      takerSide: 'SELL',
    });

    const { worker, kafka } = makeWorker(db);
    await worker.tick();

    // A 포지션 1 남음, reduceOnly 잔여합 1.5(oR2) > 1 → 최신 oR2부터 CO
    expect(db.positions.get(`A:${SYM}`)!.qty.toFixed()).toBe('1');
    expect(kafka.emit).toHaveBeenCalledTimes(1);
    expect(kafka.emit).toHaveBeenCalledWith(
      'match.futures.in',
      0,
      expect.objectContaining({ op: 'CO', id: 'oR2', u: 'A' }),
      SYM,
    );
  });

  it('liquidation 체결: 유저 LIQUIDATION_FEE + 기금 INSURANCE_CLEAR — sourceKey 충돌 없음', async () => {
    const db = new FakePrisma();
    db.seedPosition('A', 1, 50000, 5000);
    db.seedOrder({
      id: 'oA',
      userId: 'A',
      side: 'SELL',
      type: 'MARKET',
      timeInForce: 'IOC',
      origQty: d(1),
      liquidation: true,
      lockedCost: null,
    });
    db.seedOrder({
      id: 'oB',
      userId: 'B',
      side: 'BUY',
      price: d(45000),
      origQty: d(1),
      lockedCost: d('4522.5'),
    });
    db.seedWallet('A', 0);
    db.seedWallet('B', 0, '4522.5');
    db.seedWallet(FUND, 0);
    db.seedTradeEvent({
      tid: 't1',
      price: 45000,
      qty: 1,
      makerOrderId: 'oB',
      makerUserId: 'B',
      takerOrderId: 'oA',
      takerUserId: 'A',
      takerSide: 'SELL',
    });

    const { worker } = makeWorker(db);
    await worker.tick();

    // 같은 fill에서 유저 청산 수수료 차감 + 기금 적립이 둘 다 insert (unique 충돌 시 apply 전체 실패)
    expect(db.events.find((e) => e.sourceKey === 't1')!.status).toBe('APPLIED');
    const liqFee = db.incomes.find((i) => i.userId === 'A' && i.incomeType === 'LIQUIDATION_FEE')!;
    expect(liqFee.income.toFixed()).toBe('-225'); // ceil(45000×0.005)
    const clear = db.incomes.find((i) => i.userId === FUND && i.incomeType === 'INSURANCE_CLEAR')!;
    expect(clear.income.toFixed()).toBe('225');
    expect(clear.sourceKey).not.toBe(liqFee.sourceKey);
    expect(db.wallets.get(FUND)!.balance.toFixed()).toBe('225');
    // A: marginRelease 5000 + RPNL −5000 − fee 22.5 − liqFee 225
    expect(db.wallets.get('A')!.balance.toFixed()).toBe('-247.5');
  });

  it('flip 후 반대 side reduceOnly 잔존분: 청산 능력 0 — 전량 CO', async () => {
    const db = new FakePrisma();
    db.seedPosition('A', 1, 50000, 5000);
    db.seedOrder({
      id: 'oR',
      userId: 'A',
      side: 'SELL',
      price: d(55000),
      origQty: d(1),
      reduceOnly: true,
    });
    db.seedOrder({
      id: 'oA',
      userId: 'A',
      side: 'SELL',
      price: d(50000),
      origQty: d(3),
      lockedCost: d(15075),
    });
    db.seedOrder({
      id: 'oB',
      userId: 'B',
      side: 'BUY',
      price: d(50000),
      origQty: d(3),
      lockedCost: d(15075),
    });
    db.seedWallet('A', 1000, 15075);
    db.seedWallet('B', 1000, 15075);
    db.seedTradeEvent({
      tid: 't1',
      price: 50000,
      qty: 3,
      makerOrderId: 'oB',
      makerUserId: 'B',
      takerOrderId: 'oA',
      takerUserId: 'A',
      takerSide: 'SELL',
    });

    const { worker, kafka } = makeWorker(db);
    await worker.tick();

    // A 롱 +1 → SELL 3 체결로 숏 −2 flip. 잔존 reduceOnly SELL은 증량 방향 — 즉시 CO
    expect(db.positions.get(`A:${SYM}`)!.qty.toFixed()).toBe('-2');
    expect(kafka.emit).toHaveBeenCalledTimes(1);
    expect(kafka.emit).toHaveBeenCalledWith(
      'match.futures.in',
      0,
      expect.objectContaining({ op: 'CO', id: 'oR', u: 'A' }),
      SYM,
    );
  });

  it('drain은 seq 순 — createdAt 동률/역전이어도 consume insert 순서로 적용된다', async () => {
    const db = new FakePrisma();
    db.seedOrder({
      id: 'oA1',
      userId: 'A',
      side: 'BUY',
      price: d(50000),
      origQty: d(1),
      lockedCost: d(5025),
    });
    db.seedOrder({
      id: 'oA2',
      userId: 'A',
      side: 'SELL',
      price: d(51000),
      origQty: d(1),
      reduceOnly: true,
      lockedCost: null,
    });
    db.seedOrder({ id: 'oB', userId: 'B', side: 'SELL', origQty: d(1), lockedCost: d(0) });
    db.seedOrder({ id: 'oC', userId: 'C', side: 'BUY', origQty: d(1), lockedCost: d(0) });
    db.seedWallet('A', 1000, 5025);
    db.seedWallet('B', 50000);
    db.seedWallet('C', 50000);
    db.seedTradeEvent({
      tid: 't1',
      price: 50000,
      qty: 1,
      makerOrderId: 'oB',
      makerUserId: 'B',
      takerOrderId: 'oA1',
      takerUserId: 'A',
      takerSide: 'BUY',
    });
    db.seedTradeEvent({
      tid: 't2',
      price: 51000,
      qty: 1,
      makerOrderId: 'oC',
      makerUserId: 'C',
      takerOrderId: 'oA2',
      takerUserId: 'A',
      takerSide: 'SELL',
    });
    // createdAt 역전 주입 — createdAt 정렬이면 t2(close)가 t1(open)보다 먼저 적용돼 회계가 달라진다
    db.events.find((e) => e.sourceKey === 't2')!.createdAt = new Date(0);

    const { worker } = makeWorker(db);
    await worker.tick();

    const posA = db.positions.get(`A:${SYM}`)!;
    expect(posA.qty.toFixed()).toBe('0');
    expect(db.wallets.get('A')!.locked.toFixed()).toBe('0');
    // seq 순이면 t1(open)→t2(close)라 RPNL은 t2에서 실현 — createdAt 순이면 t1에서 실현된다
    const rpnl = db.incomes.filter((i) => i.userId === 'A' && i.incomeType === 'REALIZED_PNL');
    expect(rpnl).toHaveLength(1);
    expect(rpnl[0].sourceKey).toBe('t2:taker:REALIZED_PNL');
    expect(rpnl[0].income.toFixed()).toBe('1000');
  });

  it('적용 실패 시 중단 — 후속 이벤트를 건너뛰지 않는다 (순서 보존)', async () => {
    const db = new FakePrisma();
    db.seedOrder({
      id: 'oB',
      userId: 'B',
      side: 'SELL',
      price: d(50000),
      origQty: d(1),
      lockedCost: d(0),
    });
    db.seedWallet('A', 1000);
    db.seedWallet('B', 1000);
    // 첫 이벤트: 존재하지 않는 주문 참조 → 실패
    db.seedTradeEvent({
      tid: 't1',
      price: 50000,
      qty: 1,
      makerOrderId: 'oB',
      makerUserId: 'B',
      takerOrderId: 'missing',
      takerUserId: 'A',
      takerSide: 'BUY',
    });
    db.seedEvent('FUTURES_REFUND', 'frefund:oB', [
      { orderId: 'oB', userId: 'B', finalExecutedQty: '0' },
    ]);

    const { worker } = makeWorker(db);
    await worker.tick();

    // 두 번째 이벤트는 PENDING 그대로 (순서 보존 — 다음 tick 재시도 대상)
    const refund = db.events.find((e) => e.kind === 'FUTURES_REFUND')!;
    expect(refund.status).toBe('PENDING');
  });
});
