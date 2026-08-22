import { MarketType, OrderSide, TimeInForce } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { UserService } from '@app/core-domain/user/user.service';
import { UserStreamService } from '../user-stream/user-stream.service';
import { SettlementService } from '../settlement/settlement.service';
import { TriggerRegistryService } from '../trigger/trigger-registry.service';
import { OrderDispatchService } from '../order/order-dispatch.service';
import { CreateOrderListDto } from './dto/create-order-list.dto';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { JournalWriter } from '@app/core-domain/ledger/journal-writer';
import { LedgerService } from '@app/core-domain/ledger/ledger.service';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';
import { OrderListService } from './order-list.service';
import { OcoStateMachine } from './oco-state-machine';

// OCO 상태머신 박제 테스트 — in-memory fake Prisma로 현재 동작(전이/환불/레이스)을 고정한다.

const d = (v: string | number) => new Decimal(v);
const SYM = 'BTCUSDT';
const USER = 'u1';

const META = {
  symbol: SYM,
  marketType: MarketType.SPOT,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  pricePrecision: 2,
  qtyPrecision: 6,
  minNotional: d(10),
};

// SELL: price 52000 > last 50000 > stopPrice 48000, lock = base 0.1
const SELL_DTO: CreateOrderListDto = {
  tickerSymbol: SYM,
  tickerMarket: MarketType.SPOT,
  side: OrderSide.SELL,
  qty: '0.1',
  price: '52000',
  stopPrice: '48000',
  stopLimitPrice: '47900',
  stopLimitTimeInForce: TimeInForce.GTC,
};

// BUY: price 48000 < last 50000 < stopPrice 52000, lock = max(48000, 52100) * 0.1 = 5210 USDT
const BUY_DTO: CreateOrderListDto = {
  ...SELL_DTO,
  side: OrderSide.BUY,
  price: '48000',
  stopPrice: '52000',
  stopLimitPrice: '52100',
};

interface ListRow {
  id: string;
  userId: string;
  tickerSymbol: string;
  tickerMarket: MarketType;
  side: OrderSide;
  contingencyType: string;
  status: string;
  cancelRequested: boolean;
  stopPendingAt: Date | null;
  lockAssetSymbol: string;
  lockAmount: Decimal;
  createdAt: Date;
  updatedAt: Date;
}

interface OrderRow {
  id: string;
  userId: string;
  tickerSymbol: string;
  tickerMarket: MarketType;
  type: string;
  side: OrderSide;
  timeInForce: TimeInForce;
  price: Decimal | null;
  stopPrice: Decimal | null;
  origQty: Decimal | null;
  origQuoteQty: Decimal | null;
  executedQty: Decimal;
  cumulativeQuoteQty: Decimal;
  status: string;
  triggeredAt: Date | null;
  reduceOnly: boolean;
  liquidation: boolean;
  lockedCost: Decimal | null;
  orderListId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface WalletRow {
  userId: string;
  assetSymbol: string;
  marketType: MarketType;
  balance: Decimal;
  locked: Decimal;
  updatedAt: Date;
}

type Row = Record<string, unknown>;

function applyData(row: Row, data: Row): void {
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

// guarded updateMany의 where 절 평가 — 서비스가 쓰는 형태(동등/null/gte)만 지원
function matchesWhere(row: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where)) {
    const cell = row[k];
    if (v instanceof Decimal) {
      if (!(cell instanceof Decimal) || !cell.eq(v)) return false;
    } else if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const op = v as { gte?: Decimal; not?: unknown; in?: unknown[] };
      if (op.gte !== undefined && !(cell as Decimal).gte(op.gte)) return false;
      if (op.not !== undefined && cell === op.not) return false;
      if (op.in !== undefined && !op.in.includes(cell)) return false;
    } else if (v instanceof Date) {
      if (!(cell instanceof Date) || cell.getTime() !== v.getTime()) return false;
    } else if (cell !== v) {
      return false;
    }
  }
  return true;
}

function updateMany(rows: Iterable<Row>, where: Row, data: Row): { count: number } {
  let count = 0;
  for (const row of rows) {
    if (matchesWhere(row, where)) {
      applyData(row, data);
      count += 1;
    }
  }
  return { count };
}

class FakePrisma {
  lists = new Map<string, ListRow>();
  orders = new Map<string, OrderRow>();
  wallets = new Map<string, WalletRow>(); // `${userId}:${asset}:${market}`
  private seq = 0;

  orderList = {
    create: (args: { data: Row }) => {
      const row: ListRow = {
        id: `list-${++this.seq}`,
        contingencyType: 'OCO',
        status: 'EXECUTING',
        cancelRequested: false,
        stopPendingAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(args.data as Partial<ListRow>),
      } as ListRow;
      this.lists.set(row.id, row);
      return Promise.resolve({ ...row });
    },
    findUnique: (args: { where: { id: string } }) => {
      const row = this.lists.get(args.where.id);
      return Promise.resolve(row ? this.withOrders(row) : null);
    },
    updateMany: (args: { where: Row; data: Row }) =>
      Promise.resolve(updateMany(this.lists.values() as Iterable<Row>, args.where, args.data)),
    findMany: (args: { where: Row; orderBy?: Row; take?: number }) => {
      let rows = [...this.lists.values()].filter((l) =>
        matchesWhere(l as unknown as Row, args.where),
      );
      rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (args.take !== undefined) rows = rows.slice(0, args.take);
      return Promise.resolve(rows.map((r) => this.withOrders(r)));
    },
  };

  order = {
    create: (args: { data: Row }) => {
      const row = this.makeOrder(args.data as Partial<OrderRow> & { userId: string });
      return Promise.resolve({ ...row });
    },
    findUnique: (args: { where: { id: string } }) => {
      const row = this.orders.get(args.where.id);
      return Promise.resolve(row ? { ...row } : null);
    },
    updateMany: (args: { where: Row; data: Row }) =>
      Promise.resolve(updateMany(this.orders.values() as Iterable<Row>, args.where, args.data)),
    count: (args: { where: Row }) => {
      const n = [...this.orders.values()].filter((o) =>
        matchesWhere(o as unknown as Row, args.where),
      ).length;
      return Promise.resolve(n);
    },
  };

  wallet = {
    findUnique: (args: {
      where: {
        userId_assetSymbol_marketType: {
          userId: string;
          assetSymbol: string;
          marketType: MarketType;
        };
      };
    }) => {
      const k = args.where.userId_assetSymbol_marketType;
      const row = this.wallets.get(`${k.userId}:${k.assetSymbol}:${k.marketType}`);
      return Promise.resolve(row ? { ...row } : null);
    },
    updateMany: (args: { where: Row; data: Row }) =>
      Promise.resolve(updateMany(this.wallets.values() as Iterable<Row>, args.where, args.data)),
  };

  trade = {
    findFirst: () => Promise.resolve(null),
  };

  // 박제 대상 경로는 tx 중간 실패가 없어 롤백 에뮬레이션 불필요
  $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  // ---- seed helpers ----

  seedWallet(userId: string, assetSymbol: string, balance: string | number): WalletRow {
    const row: WalletRow = {
      userId,
      assetSymbol,
      marketType: MarketType.SPOT,
      balance: d(balance),
      locked: d(0),
      updatedAt: new Date(),
    };
    this.wallets.set(`${userId}:${assetSymbol}:${MarketType.SPOT}`, row);
    return row;
  }

  makeOrder(over: Partial<OrderRow> & { userId: string }): OrderRow {
    const row: OrderRow = {
      id: `order-${++this.seq}`,
      tickerSymbol: SYM,
      tickerMarket: MarketType.SPOT,
      type: 'LIMIT',
      side: OrderSide.SELL,
      timeInForce: TimeInForce.GTC,
      price: null,
      stopPrice: null,
      origQty: d('0.1'),
      origQuoteQty: null,
      executedQty: d(0),
      cumulativeQuoteQty: d(0),
      status: 'NEW',
      triggeredAt: null,
      reduceOnly: false,
      liquidation: false,
      lockedCost: null,
      orderListId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    } as OrderRow;
    this.orders.set(row.id, row);
    return row;
  }

  /** EXECUTING OCO 리스트 + 양 레그 시드. 반환 row는 live — 테스트가 직접 status를 조작해 OU 반영을 흉내낸다. */
  seedOco(
    over: {
      side?: OrderSide;
      userId?: string;
      list?: Partial<ListRow>;
      limit?: Partial<OrderRow>;
      stop?: Partial<OrderRow>;
    } = {},
  ): { list: ListRow; limit: OrderRow; stop: OrderRow } {
    const side = over.side ?? OrderSide.SELL;
    const userId = over.userId ?? USER;
    const sell = side === OrderSide.SELL;
    const list: ListRow = {
      id: `list-${++this.seq}`,
      userId,
      tickerSymbol: SYM,
      tickerMarket: MarketType.SPOT,
      side,
      contingencyType: 'OCO',
      status: 'EXECUTING',
      cancelRequested: false,
      stopPendingAt: null,
      lockAssetSymbol: sell ? 'BTC' : 'USDT',
      lockAmount: sell ? d('0.1') : d('5210'),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over.list,
    };
    this.lists.set(list.id, list);
    const limit = this.makeOrder({
      userId,
      type: 'LIMIT',
      side,
      price: sell ? d(52000) : d(48000),
      origQty: d('0.1'),
      orderListId: list.id,
      ...over.limit,
    });
    const stop = this.makeOrder({
      userId,
      type: 'STOP_LOSS_LIMIT',
      side,
      price: sell ? d(47900) : d(52100),
      stopPrice: sell ? d(48000) : d(52000),
      origQty: d('0.1'),
      orderListId: list.id,
      ...over.stop,
    });
    return { list, limit, stop };
  }

  private withOrders(list: ListRow): ListRow & { orders: OrderRow[] } {
    const orders = [...this.orders.values()]
      .filter((o) => o.orderListId === list.id)
      .map((o) => ({ ...o }));
    return { ...list, orders };
  }
}

function makeService(db: FakePrisma, opts: { lastPrice?: string | null; truth?: boolean } = {}) {
  const lastPrice = opts.lastPrice === undefined ? '50000' : opts.lastPrice;
  const tickerStats = {
    metaOf: jest.fn().mockReturnValue(META),
    snapshotOne: jest.fn().mockReturnValue(lastPrice === null ? null : { lastPrice }),
    avgPrice5m: jest.fn().mockReturnValue(lastPrice), // 밴드 기준가 = last(테스트 단순화)
    assertTradable: jest.fn().mockResolvedValue(undefined),
  };
  const userStream = {
    emitAccountPosition: jest.fn(),
    emitExecutionReport: jest.fn(),
    emitListStatus: jest.fn(),
  };
  const settlement = { recordListRefund: jest.fn().mockResolvedValue(undefined) };
  const registry = new TriggerRegistryService();
  const dispatch = {
    dispatchNewOrder: jest.fn().mockResolvedValue(undefined),
    dispatchCancelOrder: jest.fn().mockResolvedValue(undefined),
  };
  const users = { assertCanTrade: jest.fn().mockResolvedValue(undefined) };
  // S0 원장 섀도(박제): writeInTx는 toEntry가 처리 가능한 최소 row를 반환, ledger는 no-op 스텁.
  const journal = {
    writeInTx: jest.fn().mockResolvedValue({
      seq: 1,
      sourceKey: 'lock:list:test',
      userId: USER,
      assetSymbol: 'BTC',
      marketType: MarketType.SPOT,
      deltaBalance: d(0),
      deltaLocked: d(0),
    }),
  };
  // 기본은 S0(availability disabled → Wallet 경로) — 기존 박제 불변. truth:true면 진실 스위치 경로.
  const truth = opts.truth ?? false;
  const ledger = truth
    ? new LedgerService([MarketType.SPOT])
    : ({ owns: jest.fn().mockReturnValue(true), applyJournal: jest.fn() } as unknown as LedgerService);
  const availability = { enabled: truth } as unknown as LedgerAvailability;
  const service = new OrderListService(
    db as unknown as PrismaService,
    tickerStats as unknown as TickerStatsService,
    userStream as unknown as UserStreamService,
    settlement as unknown as SettlementService,
    registry,
    dispatch as unknown as OrderDispatchService,
    new OcoStateMachine(db as unknown as PrismaService),
    users as unknown as UserService,
    journal as unknown as JournalWriter,
    ledger,
    availability,
  );
  return { service, tickerStats, userStream, settlement, registry, dispatch, users, ledger };
}

type Harness = ReturnType<typeof makeService>;

function refundCalls(h: Harness) {
  return h.settlement.recordListRefund.mock.calls.map(
    (c: unknown[]) => c[0] as { listId: string; assetSymbol: string; amount: Decimal },
  );
}

/** n번째 dispatch 호출의 주문 인자 (NO/CO 대상 검증용). */
function dispatchedOrder(fn: jest.Mock, nth = 0): { id: string } {
  return (fn.mock.calls[nth] as [{ id: string }])[0];
}

function reportsOf(h: Harness, orderId: string) {
  return h.userStream.emitExecutionReport.mock.calls
    .map((c: unknown[]) => c[1] as { orderId: string; status: string })
    .filter((r) => r.orderId === orderId);
}

describe('OrderListService (OCO 박제)', () => {
  // ---------- placement ----------

  it('createOcoList SELL: base 잠금 1회 + 두 레그 생성 + limit NO + stop은 registry만', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'BTC', 1);
    const h = makeService(db);

    const res = await h.service.createOcoList(USER, SELL_DTO);

    const wallet = db.wallets.get(`${USER}:BTC:${MarketType.SPOT}`)!;
    expect(wallet.balance.toFixed()).toBe('0.9');
    expect(wallet.locked.toFixed()).toBe('0.1');

    expect(res.orderList.lockAssetSymbol).toBe('BTC');
    expect(res.orderList.lockAmount.toFixed()).toBe('0.1');
    expect(res.orders).toHaveLength(2);
    const [limit, stop] = res.orders;
    expect(limit.type).toBe('LIMIT');
    expect(limit.stopPrice).toBeNull();
    expect(stop.type).toBe('STOP_LOSS_LIMIT');
    expect(stop.stopPrice!.toFixed()).toBe('48000');
    expect(stop.triggeredAt).toBeNull();

    // limit만 엔진 전송, stop은 BE 보관(트리거 registry)
    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchNewOrder).id).toBe(limit.id);
    expect(h.dispatch.dispatchCancelOrder).not.toHaveBeenCalled();
    expect(h.registry.size()).toBe(1);
    expect(h.registry.pendingFor(MarketType.SPOT, SYM)[0].id).toBe(stop.id);

    expect(h.userStream.emitAccountPosition).toHaveBeenCalledTimes(1);
    expect(h.userStream.emitExecutionReport).toHaveBeenCalledTimes(2);
    expect(h.userStream.emitListStatus).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ orderListId: res.orderList.id, status: 'EXECUTING' }),
    );
  });

  it('createOcoList BUY: lockAmount = max(price, stopLimitPrice) × qty (quote 자산)', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 10000);
    const h = makeService(db);

    const res = await h.service.createOcoList(USER, BUY_DTO);

    expect(res.orderList.lockAssetSymbol).toBe('USDT');
    expect(res.orderList.lockAmount.toFixed()).toBe('5210'); // max(48000, 52100) * 0.1
    const wallet = db.wallets.get(`${USER}:USDT:${MarketType.SPOT}`)!;
    expect(wallet.balance.toFixed()).toBe('4790');
    expect(wallet.locked.toFixed()).toBe('5210');
  });

  it('createOcoList 가격 관계 위반(SELL): OCO_PRICE_INVALID, 부수효과 없음', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'BTC', 1);
    const h = makeService(db);

    await expect(
      h.service.createOcoList(USER, { ...SELL_DTO, stopPrice: '50000' }), // last(50000) > stopPrice 위반
    ).rejects.toMatchObject({ code: ErrorCode.OCO_PRICE_INVALID });

    expect(db.wallets.get(`${USER}:BTC:${MarketType.SPOT}`)!.locked.toFixed()).toBe('0');
    expect(db.lists.size).toBe(0);
    expect(db.orders.size).toBe(0);
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
  });

  it('createOcoList last price 부재: 가격 관계 검증 불가 → OCO_PRICE_INVALID', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'BTC', 1);
    const h = makeService(db, { lastPrice: null });

    await expect(h.service.createOcoList(USER, SELL_DTO)).rejects.toMatchObject({
      code: ErrorCode.OCO_PRICE_INVALID,
    });
  });

  it('createOcoList 잔고 부족: INSUFFICIENT_BALANCE, 리스트/주문 미생성', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'BTC', '0.05'); // lock 0.1 필요
    const h = makeService(db);

    await expect(h.service.createOcoList(USER, SELL_DTO)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_BALANCE,
    });

    expect(db.lists.size).toBe(0);
    expect(db.orders.size).toBe(0);
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
  });

  // ---------- Flow A: limit 레그 체결 ----------

  it('onLegExecuted: limit 체결 → stop 로컬 취소(NEW+미트리거 한정), finalize는 아직', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco();
    const h = makeService(db);
    h.registry.add(stop as never);

    await h.service.onLegExecuted(limit.id);

    expect(db.orders.get(stop.id)!.status).toBe('CANCELED');
    expect(h.registry.size()).toBe(0);
    expect(reportsOf(h, stop.id)).toEqual([expect.objectContaining({ status: 'CANCELED' })]);
    // limit 비terminal — 종결/환불 없음
    expect(db.lists.get(list.id)!.status).toBe('EXECUTING');
    expect(h.settlement.recordListRefund).not.toHaveBeenCalled();
  });

  it('Flow A 종결(SELL): limit FILLED → ALL_DONE + listref 환불 1건 (전량 사용 → 0)', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco();
    const h = makeService(db);

    await h.service.onLegExecuted(limit.id); // stop 로컬 취소
    db.orders.get(limit.id)!.status = 'FILLED'; // match-result가 OU status 선기록
    await h.service.onLegTerminal(list.id, { orderId: limit.id, eq: d('0.1'), cqq: d('5200') });

    expect(db.lists.get(list.id)!.status).toBe('ALL_DONE');
    const refunds = refundCalls(h);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].listId).toBe(list.id);
    expect(refunds[0].assetSymbol).toBe('BTC');
    expect(refunds[0].amount.toFixed()).toBe('0'); // lock 0.1 − eq 0.1
    expect(h.userStream.emitListStatus).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        status: 'ALL_DONE',
        orders: [
          { orderId: limit.id, status: 'FILLED' },
          { orderId: stop.id, status: 'CANCELED' },
        ],
      }),
    );
  });

  it('Flow A 종결(BUY): 환불 = lockAmount − cqq (quote 기준)', async () => {
    const db = new FakePrisma();
    const { list, limit } = db.seedOco({ side: OrderSide.BUY });
    const h = makeService(db);

    await h.service.onLegExecuted(limit.id);
    db.orders.get(limit.id)!.status = 'FILLED';
    await h.service.onLegTerminal(list.id, { orderId: limit.id, eq: d('0.1'), cqq: d('4800') });

    const refunds = refundCalls(h);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].assetSymbol).toBe('USDT');
    expect(refunds[0].amount.toFixed()).toBe('410'); // 5210 − 4800
  });

  it('terminal OU 재전달: finalize claim 멱등 — 환불/listStatus 1회 유지', async () => {
    const db = new FakePrisma();
    const { list, limit } = db.seedOco();
    const h = makeService(db);

    await h.service.onLegExecuted(limit.id);
    db.orders.get(limit.id)!.status = 'FILLED';
    const hint = { orderId: limit.id, eq: d('0.1'), cqq: d('5200') };
    await h.service.onLegTerminal(list.id, hint);
    await h.service.onLegTerminal(list.id, hint); // 재전달

    expect(refundCalls(h)).toHaveLength(1);
    const allDone = h.userStream.emitListStatus.mock.calls.filter(
      (c: unknown[]) => (c[1] as { status: string }).status === 'ALL_DONE',
    );
    expect(allDone).toHaveLength(1);
  });

  // ---------- Flow B: stop 트리거 ----------

  it('onStopTriggered: stopPendingAt guarded claim + limit 레그 CO 전송', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco();
    const h = makeService(db);

    await h.service.onStopTriggered(stop as never);

    expect(db.lists.get(list.id)!.stopPendingAt).toBeInstanceOf(Date);
    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchCancelOrder).id).toBe(limit.id);
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled(); // stop NO는 limit terminal 확인 후
  });

  it('이중 트리거: 두 번째 claim 0 → CO 1회만', async () => {
    const db = new FakePrisma();
    const { stop } = db.seedOco();
    const h = makeService(db);

    await h.service.onStopTriggered(stop as never);
    await h.service.onStopTriggered(stop as never);

    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
  });

  it('Flow B step 2 (limit CANCELED eq=0): stop arming — triggeredAt claim + NO + stopPendingAt 해제', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco();
    const h = makeService(db);
    h.registry.add(stop as never);

    await h.service.onStopTriggered(stop as never);
    db.orders.get(limit.id)!.status = 'CANCELED'; // 엔진 CO 결과 OU
    await h.service.onLegTerminal(list.id, { orderId: limit.id, eq: d(0), cqq: d(0) });

    const stopRow = db.orders.get(stop.id)!;
    expect(stopRow.status).toBe('NEW');
    expect(stopRow.triggeredAt).toBeInstanceOf(Date);
    expect(h.registry.size()).toBe(0);
    expect(db.lists.get(list.id)!.stopPendingAt).toBeNull();
    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchNewOrder).id).toBe(stop.id);
    expect(reportsOf(h, stop.id)).toEqual([expect.objectContaining({ status: 'NEW' })]);
    // 리스트는 계속 EXECUTING — 환불 없음
    expect(db.lists.get(list.id)!.status).toBe('EXECUTING');
    expect(h.settlement.recordListRefund).not.toHaveBeenCalled();
  });

  it('Flow B step 2 (limit CANCELED eq>0): arming 대신 stop 로컬 취소 + finalize, 환불 = lock − eq', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco({
      list: { stopPendingAt: new Date() },
    });
    const h = makeService(db);

    db.orders.get(limit.id)!.status = 'CANCELED';
    await h.service.onLegTerminal(list.id, { orderId: limit.id, eq: d('0.04'), cqq: d('2080') });

    expect(db.orders.get(stop.id)!.status).toBe('CANCELED');
    expect(db.orders.get(stop.id)!.triggeredAt).toBeNull();
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
    expect(db.lists.get(list.id)!.status).toBe('ALL_DONE');
    expect(db.lists.get(list.id)!.stopPendingAt).toBeNull();
    const refunds = refundCalls(h);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount.toFixed()).toBe('0.06'); // 0.1 − 0.04
  });

  it('Flow B 완주: arming 후 stop FILLED → finalize, used = stop eq', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco();
    const h = makeService(db);

    await h.service.onStopTriggered(stop as never);
    db.orders.get(limit.id)!.status = 'CANCELED';
    await h.service.onLegTerminal(list.id, { orderId: limit.id, eq: d(0), cqq: d(0) }); // arming
    db.orders.get(stop.id)!.status = 'FILLED';
    await h.service.onLegTerminal(list.id, { orderId: stop.id, eq: d('0.1'), cqq: d('4790') });

    expect(db.lists.get(list.id)!.status).toBe('ALL_DONE');
    const refunds = refundCalls(h);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount.toFixed()).toBe('0'); // 0.1 − (0 + 0.1)
  });

  it('트리거 시 limit 이미 terminal(FILLED): CO 없이 즉시 step 2 — stop 로컬 취소 + finalize', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco();
    const h = makeService(db);

    // FILLED OU가 먼저 처리된 상황 (hint 적재)
    db.orders.get(limit.id)!.status = 'FILLED';
    await h.service.onLegTerminal(list.id, { orderId: limit.id, eq: d('0.1'), cqq: d('5200') });
    h.dispatch.dispatchCancelOrder.mockClear();

    await h.service.onStopTriggered(db.orders.get(stop.id) as never);

    expect(h.dispatch.dispatchCancelOrder).not.toHaveBeenCalled();
    expect(db.orders.get(stop.id)!.status).toBe('CANCELED');
    expect(db.lists.get(list.id)!.status).toBe('ALL_DONE');
    expect(db.lists.get(list.id)!.stopPendingAt).toBeNull();
    expect(refundCalls(h)).toHaveLength(1);
  });

  // ---------- 유저 취소 ----------

  it('cancelList: cancelRequested claim → stop 로컬 취소 + limit CO → 이후 OU로 전액 환불', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco();
    const h = makeService(db);
    h.registry.add(stop as never);

    const res = await h.service.cancelList(USER, list.id);

    expect(res.orderList.cancelRequested).toBe(true);
    expect(db.orders.get(stop.id)!.status).toBe('CANCELED');
    expect(h.registry.size()).toBe(0);
    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchCancelOrder).id).toBe(limit.id);
    expect(db.lists.get(list.id)!.status).toBe('EXECUTING'); // limit OU 대기

    db.orders.get(limit.id)!.status = 'CANCELED';
    await h.service.onLegTerminal(list.id, { orderId: limit.id, eq: d(0), cqq: d(0) });

    expect(db.lists.get(list.id)!.status).toBe('ALL_DONE');
    const refunds = refundCalls(h);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount.toFixed()).toBe('0.1'); // 전액
  });

  it('cancelList 소유자 아님: FORBIDDEN, 상태 무변동', async () => {
    const db = new FakePrisma();
    const { list, stop } = db.seedOco();
    const h = makeService(db);

    await expect(h.service.cancelList('other', list.id)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
    expect(db.lists.get(list.id)!.cancelRequested).toBe(false);
    expect(db.orders.get(stop.id)!.status).toBe('NEW');
  });

  it('cancelList 비EXECUTING: NOT_CANCELABLE — idempotent 옵션이면 무throw', async () => {
    const db = new FakePrisma();
    const { list } = db.seedOco({ list: { status: 'ALL_DONE' } });
    const h = makeService(db);

    await expect(h.service.cancelList(USER, list.id)).rejects.toMatchObject({
      code: ErrorCode.ORDER_LIST_NOT_CANCELABLE,
    });

    const res = await h.service.cancelList(USER, list.id, { idempotent: true });
    expect(res.orderList.id).toBe(list.id);
    expect(h.dispatch.dispatchCancelOrder).not.toHaveBeenCalled();
  });

  it('cancelList 레이스(stop armed): 로컬 취소 claim 실패 → stop에도 CO (엔진 거주 대비)', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco({
      stop: { triggeredAt: new Date() }, // armed — 엔진에 있을 수 있음
    });
    const h = makeService(db);

    await h.service.cancelList(USER, list.id);

    expect(db.orders.get(stop.id)!.status).toBe('NEW'); // 로컬 취소 불가
    const coIds = h.dispatch.dispatchCancelOrder.mock.calls.map(
      (c: unknown[]) => (c[0] as { id: string }).id,
    );
    expect(coIds.sort()).toEqual([limit.id, stop.id].sort());
    expect(db.lists.get(list.id)!.cancelRequested).toBe(true);
    expect(db.lists.get(list.id)!.status).toBe('EXECUTING');
  });

  it('취소 vs arming 레이스: cancelRequested면 limit CANCELED eq=0이어도 arming 차단 → 전액 환불', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco({
      list: { cancelRequested: true, stopPendingAt: new Date() },
    });
    const h = makeService(db);

    db.orders.get(limit.id)!.status = 'CANCELED';
    await h.service.onLegTerminal(list.id, { orderId: limit.id, eq: d(0), cqq: d(0) });

    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled(); // arming 금지
    expect(db.orders.get(stop.id)!.status).toBe('CANCELED');
    expect(db.lists.get(list.id)!.status).toBe('ALL_DONE');
    const refunds = refundCalls(h);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount.toFixed()).toBe('0.1');
  });

  it('취소 vs arming 레이스(NO 전송 중 취소 claim): NO ack 후 재확인 → stop 추격 CO', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco({ list: { stopPendingAt: new Date() } });
    const h = makeService(db);
    // NO 전송 사이에 cancelList의 cancelRequested claim이 커밋되는 인터리빙 재현
    h.dispatch.dispatchNewOrder.mockImplementation(() => {
      db.lists.get(list.id)!.cancelRequested = true;
      return Promise.resolve();
    });

    db.orders.get(limit.id)!.status = 'CANCELED';
    await h.service.onLegTerminal(list.id, { orderId: limit.id, eq: d(0), cqq: d(0) }); // arming

    expect(dispatchedOrder(h.dispatch.dispatchNewOrder).id).toBe(stop.id);
    // 앞질러 무시됐을 취소 CO를 NO 뒤 순서로 재전송
    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchCancelOrder).id).toBe(stop.id);

    // 이후 엔진 CO 결과(OU C)로 정상 종결 — 전액 환불, 유저 취소 관철
    db.orders.get(stop.id)!.status = 'CANCELED';
    await h.service.onLegTerminal(list.id, { orderId: stop.id, eq: d(0), cqq: d(0) });
    expect(db.lists.get(list.id)!.status).toBe('ALL_DONE');
    expect(refundCalls(h)[0].amount.toFixed()).toBe('0.1');
  });

  it('arming 시 취소 요청 없음: 추격 CO 없음', async () => {
    const db = new FakePrisma();
    const { list, limit } = db.seedOco({ list: { stopPendingAt: new Date() } });
    const h = makeService(db);

    db.orders.get(limit.id)!.status = 'CANCELED';
    await h.service.onLegTerminal(list.id, { orderId: limit.id, eq: d(0), cqq: d(0) });

    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
    expect(h.dispatch.dispatchCancelOrder).not.toHaveBeenCalled();
  });

  // ---------- 발화 실패 재드라이브 (trigger가 redrive=true로 재발화) ----------

  it('onStopTriggered redrive: claim 선점(stopPendingAt) 상태 → 유실된 limit CO 재전송', async () => {
    const db = new FakePrisma();
    const { limit, stop } = db.seedOco({ list: { stopPendingAt: new Date() } });
    const h = makeService(db);

    await h.service.onStopTriggered(db.orders.get(stop.id) as never, true);

    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchCancelOrder).id).toBe(limit.id);
  });

  it('onStopTriggered redrive: cancelRequested면 재드라이브 안 함 (취소 경로 소관)', async () => {
    const db = new FakePrisma();
    const { stop } = db.seedOco({
      list: { stopPendingAt: new Date(), cancelRequested: true },
    });
    const h = makeService(db);

    await h.service.onStopTriggered(db.orders.get(stop.id) as never, true);

    expect(h.dispatch.dispatchCancelOrder).not.toHaveBeenCalled();
  });

  it('onStopTriggered redrive: limit terminal + armed NEW stop → stop NO 재드라이브 + 리포트', async () => {
    const db = new FakePrisma();
    const { stop } = db.seedOco({
      limit: { status: 'CANCELED' },
      stop: { triggeredAt: new Date() },
    });
    const h = makeService(db);

    await h.service.onStopTriggered(db.orders.get(stop.id) as never, true);

    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchNewOrder).id).toBe(stop.id);
    expect(reportsOf(h, stop.id)).toEqual([expect.objectContaining({ status: 'NEW' })]);
    expect(h.dispatch.dispatchCancelOrder).not.toHaveBeenCalled(); // 취소 요청 없음 — 추격 CO 없음
  });

  // ---------- 복구 / 기타 ----------

  it('복구 전 hint 없는 terminal 레그: 결정 보류 — finalize/arming 미실행', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco({
      limit: { status: 'CANCELED' }, // DB eq/cqq가 stale일 수 있는 상황
    });
    const h = makeService(db);

    await h.service.onLegTerminal(list.id); // hint 없음 + recovered=false

    expect(db.orders.get(stop.id)!.status).toBe('NEW');
    expect(db.orders.get(stop.id)!.triggeredAt).toBeNull();
    expect(db.lists.get(list.id)!.status).toBe('EXECUTING');
    expect(h.settlement.recordListRefund).not.toHaveBeenCalled();
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
    void limit;
  });

  it('부트 복구: stopPendingAt + limit 비terminal → limit CO 재전송', async () => {
    const db = new FakePrisma();
    const { list, limit } = db.seedOco({ list: { stopPendingAt: new Date() } });
    const h = makeService(db);

    await h.service.runBootRecovery();

    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchCancelOrder).id).toBe(limit.id);
    expect(db.lists.get(list.id)!.status).toBe('EXECUTING');
  });

  it('부트 복구: armed-but-unsent stop(NEW+triggeredAt) → stop NO 재전송', async () => {
    const db = new FakePrisma();
    const { stop } = db.seedOco({ stop: { triggeredAt: new Date() } });
    const h = makeService(db);

    await h.service.runBootRecovery();

    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchNewOrder).id).toBe(stop.id);
  });

  it('부트 복구: cancelRequested + armed NEW stop → NO 재드라이브 후 CO (취소 관철)', async () => {
    const db = new FakePrisma();
    const { list, stop } = db.seedOco({
      list: { cancelRequested: true },
      limit: { status: 'CANCELED' },
      stop: { triggeredAt: new Date() },
    });
    const h = makeService(db);

    await h.service.runBootRecovery();

    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchNewOrder).id).toBe(stop.id);
    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchCancelOrder).id).toBe(stop.id);
    // NO가 CO보다 먼저 — 같은 파티션에서 순서 보장돼 엔진이 취소를 인지
    expect(h.dispatch.dispatchNewOrder.mock.invocationCallOrder[0]).toBeLessThan(
      h.dispatch.dispatchCancelOrder.mock.invocationCallOrder[0],
    );
    expect(db.lists.get(list.id)!.status).toBe('EXECUTING'); // stop OU 대기
  });

  it('부트 복구: cancelRequested + 미트리거 stop → stop 로컬 취소 + limit CO', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco({
      list: { cancelRequested: true },
      limit: { status: 'OPEN' },
    });
    const h = makeService(db);
    h.registry.add(db.orders.get(stop.id) as never);

    await h.service.runBootRecovery();

    expect(db.orders.get(stop.id)!.status).toBe('CANCELED');
    expect(h.registry.size()).toBe(0);
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchCancelOrder).id).toBe(limit.id);
    expect(db.lists.get(list.id)!.status).toBe('EXECUTING'); // limit OU 대기
  });

  it('부트 복구: cancelRequested + 엔진 거주 stop(OPEN) → CO만 재전송 (NO 없음)', async () => {
    const db = new FakePrisma();
    const { stop } = db.seedOco({
      list: { cancelRequested: true },
      limit: { status: 'CANCELED' },
      stop: { status: 'OPEN', triggeredAt: new Date() },
    });
    const h = makeService(db);

    await h.service.runBootRecovery();

    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchCancelOrder).id).toBe(stop.id);
  });

  it('부트 복구: 양 레그 terminal + EXECUTING → DB eq/cqq로 finalize (잠금 누수 방지)', async () => {
    const db = new FakePrisma();
    const { list } = db.seedOco({
      limit: { status: 'CANCELED', executedQty: d('0.03'), cumulativeQuoteQty: d('1560') },
      stop: { status: 'CANCELED' },
    });
    const h = makeService(db);

    await h.service.runBootRecovery();

    expect(db.lists.get(list.id)!.status).toBe('ALL_DONE');
    const refunds = refundCalls(h);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount.toFixed()).toBe('0.07'); // 0.1 − 0.03 (SELL: eq 기준)
  });

  it('부트 복구: 크래시 윈도우(양 레그 NEW + stopPendingAt null + 미트리거) → limit NO 재전송', async () => {
    const db = new FakePrisma();
    const { list, limit } = db.seedOco(); // 기본 = 크래시 윈도우 상태와 동일
    const h = makeService(db);

    await h.service.runBootRecovery();

    // limit NO 재드라이브(엔진 멱등이라 이미 resting이면 무시). stop 재arm은 trigger.service 담당.
    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
    expect(dispatchedOrder(h.dispatch.dispatchNewOrder).id).toBe(limit.id);
    expect(h.dispatch.dispatchCancelOrder).not.toHaveBeenCalled();
    expect(db.lists.get(list.id)!.status).toBe('EXECUTING');
  });

  it('양 레그 REJECTED 무체결: 리스트 REJECTED + 전액 환불', async () => {
    const db = new FakePrisma();
    const { list, limit, stop } = db.seedOco({
      limit: { status: 'REJECTED' },
      stop: { status: 'REJECTED' },
    });
    const h = makeService(db);

    // 첫 OU: stop hint 부재로 보류 → 둘째 OU에서 종결 (recovered 전 hint 게이트)
    await h.service.onLegTerminal(list.id, { orderId: limit.id, eq: d(0), cqq: d(0) });
    expect(db.lists.get(list.id)!.status).toBe('EXECUTING');
    await h.service.onLegTerminal(list.id, { orderId: stop.id, eq: d(0), cqq: d(0) });

    expect(db.lists.get(list.id)!.status).toBe('REJECTED');
    const refunds = refundCalls(h);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount.toFixed()).toBe('0.1');
    expect(h.userStream.emitListStatus).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ status: 'REJECTED' }),
    );
  });

  it('onLegExecuted: 리스트 무소속 주문은 no-op', async () => {
    const db = new FakePrisma();
    const solo = db.makeOrder({ userId: USER, price: d(50000) });
    const h = makeService(db);

    await h.service.onLegExecuted(solo.id);

    expect(h.dispatch.dispatchCancelOrder).not.toHaveBeenCalled();
    expect(h.settlement.recordListRefund).not.toHaveBeenCalled();
  });
});
