import { MarketType, Order, OrderSide, OrderType, TimeInForce } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { UserService } from '@app/core-domain/user/user.service';
import { UserStreamService } from '../user-stream/user-stream.service';
import { SettlementService } from '../settlement/settlement.service';
import { TriggerRegistryService } from '../trigger/trigger-registry.service';
import { OrderListService } from '../order-list/order-list.service';
import { OrderDispatchService } from './order-dispatch.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { OrderService } from './order.service';

// OrderService 박제 테스트 — 잠금 자산/금액, 조건부 차감, 취소/환불 경계의 현재 동작을 고정한다.

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

const BASE = {
  tickerSymbol: SYM,
  tickerMarket: MarketType.SPOT,
  timeInForce: TimeInForce.GTC,
};

function dto(over: Partial<CreateOrderDto>): CreateOrderDto {
  return { ...BASE, type: OrderType.LIMIT, side: OrderSide.BUY, ...over } as CreateOrderDto;
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

// 서비스가 쓰는 where 형태(동등/null/gte/in/not)만 지원
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
  orders = new Map<string, OrderRow>();
  wallets = new Map<string, WalletRow>(); // `${userId}:${asset}:${market}`
  private seq = 0;

  order = {
    create: (args: { data: Row }) => {
      const row = this.makeOrder(args.data as Partial<OrderRow> & { userId: string });
      return Promise.resolve({ ...row });
    },
    findUnique: (args: { where: { id: string } }) => {
      const row = this.orders.get(args.where.id);
      return Promise.resolve(row ? { ...row } : null);
    },
    findMany: (args: { where: Row }) => {
      const rows = [...this.orders.values()].filter((o) =>
        matchesWhere(o as unknown as Row, args.where),
      );
      rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return Promise.resolve(rows.map((r) => ({ ...r })));
    },
    findFirst: (args: { where: Row }) => {
      const rows = [...this.orders.values()].filter((o) =>
        matchesWhere(o as unknown as Row, args.where),
      );
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return Promise.resolve(rows.length ? { ...rows[0] } : null);
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

  // 박제 대상 경로는 차감 실패 시 선행 mutation이 없어 롤백 에뮬레이션 불필요
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
      side: OrderSide.BUY,
      timeInForce: TimeInForce.GTC,
      price: null,
      stopPrice: null,
      origQty: null,
      origQuoteQty: null,
      executedQty: d(0),
      cumulativeQuoteQty: d(0),
      status: 'NEW',
      triggeredAt: null,
      reduceOnly: false,
      liquidation: false,
      lockedCost: null,
      orderListId: null,
      createdAt: new Date(this.seq), // 시드 순서 = createdAt 순서
      updatedAt: new Date(),
      ...over,
    } as OrderRow;
    this.orders.set(row.id, row);
    return row;
  }
}

function makeService(db: FakePrisma, opts: { lastPrice?: string | null } = {}) {
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
  };
  const settlement = { recordDustRefund: jest.fn().mockResolvedValue(undefined) };
  const registry = new TriggerRegistryService();
  const orderLists = { cancelList: jest.fn().mockResolvedValue({ canceled: true }) };
  const dispatch = {
    dispatchNewOrder: jest.fn().mockResolvedValue(undefined),
    dispatchCancelOrder: jest.fn().mockResolvedValue(undefined),
  };
  const users = { assertCanTrade: jest.fn().mockResolvedValue(undefined) };
  const service = new OrderService(
    db as unknown as PrismaService,
    tickerStats as unknown as TickerStatsService,
    userStream as unknown as UserStreamService,
    settlement as unknown as SettlementService,
    registry,
    orderLists as unknown as OrderListService,
    dispatch as unknown as OrderDispatchService,
    users as unknown as UserService,
  );
  return { service, tickerStats, userStream, settlement, registry, orderLists, dispatch, users };
}

type Harness = ReturnType<typeof makeService>;

function wallet(db: FakePrisma, asset: string): WalletRow {
  return db.wallets.get(`${USER}:${asset}:${MarketType.SPOT}`)!;
}

function reportsOf(h: Harness, orderId: string) {
  return h.userStream.emitExecutionReport.mock.calls
    .map((c: unknown[]) => c[1] as { orderId: string; status: string })
    .filter((r) => r.orderId === orderId);
}

describe('OrderService (박제)', () => {
  // ---------- placement: 잠금 자산/금액 ----------

  it('LIMIT BUY: quote 잠금 = price × origQty, NEW 생성 + 잔고/리포트 emit + 엔진 NO', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 10000);
    const h = makeService(db);

    const order = (await h.service.submitNewOrder(
      USER,
      dto({ price: '50000', origQty: '0.1' }),
    )) as Order;

    const w = wallet(db, 'USDT');
    expect(w.balance.toFixed()).toBe('5000'); // 10000 − 50000×0.1
    expect(w.locked.toFixed()).toBe('5000');
    expect(order.status).toBe('NEW');
    expect(order.price!.toFixed()).toBe('50000');

    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
    expect((h.dispatch.dispatchNewOrder.mock.calls[0] as [{ id: string }])[0].id).toBe(order.id);
    expect(h.userStream.emitAccountPosition).toHaveBeenCalledWith(USER, [
      expect.objectContaining({ asset: 'USDT', free: '5000.00000000', locked: '5000.00000000' }),
    ]);
    expect(reportsOf(h, order.id)).toEqual([expect.objectContaining({ status: 'NEW' })]);
    expect(h.registry.size()).toBe(0); // 비stop은 registry 미등록
  });

  it('LIMIT SELL: base 잠금 = origQty', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'BTC', 1);
    const h = makeService(db);

    await h.service.submitNewOrder(
      USER,
      dto({ side: OrderSide.SELL, price: '52000', origQty: '0.1' }),
    );

    const w = wallet(db, 'BTC');
    expect(w.balance.toFixed()).toBe('0.9');
    expect(w.locked.toFixed()).toBe('0.1');
  });

  it('POST_ONLY BUY: limit-like 동일 — quote 잠금 = price × origQty', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 10000);
    const h = makeService(db);

    const order = (await h.service.submitNewOrder(
      USER,
      dto({ type: OrderType.POST_ONLY, price: '49000', origQty: '0.2' }),
    )) as Order;

    expect(wallet(db, 'USDT').locked.toFixed()).toBe('9800'); // 49000×0.2
    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
    void order;
  });

  it('MARKET BUY (quote-driven): quote 잠금 = origQuoteQty', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 10000);
    const h = makeService(db);

    const order = (await h.service.submitNewOrder(
      USER,
      dto({ type: OrderType.MARKET, origQuoteQty: '5000' }),
    )) as Order;

    expect(wallet(db, 'USDT').locked.toFixed()).toBe('5000');
    expect(order.origQuoteQty!.toFixed()).toBe('5000');
    expect(order.origQty).toBeNull();
    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
  });

  it('MARKET SELL (base-driven): base 잠금 = origQty', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'BTC', 1);
    const h = makeService(db);

    await h.service.submitNewOrder(
      USER,
      dto({ type: OrderType.MARKET, side: OrderSide.SELL, origQty: '0.3' }),
    );

    expect(wallet(db, 'BTC').locked.toFixed()).toBe('0.3');
  });

  it('STOP_LOSS SELL: base 잠금, 엔진 미전송 — registry 보관', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'BTC', 1);
    const h = makeService(db);

    const order = (await h.service.submitNewOrder(
      USER,
      dto({ type: OrderType.STOP_LOSS, side: OrderSide.SELL, stopPrice: '48000', origQty: '0.1' }),
    )) as Order;

    expect(wallet(db, 'BTC').locked.toFixed()).toBe('0.1');
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
    expect(h.registry.size()).toBe(1);
    expect(h.registry.pendingFor(MarketType.SPOT, SYM)[0].id).toBe(order.id);
    expect(reportsOf(h, order.id)).toEqual([expect.objectContaining({ status: 'NEW' })]);
  });

  it('STOP_LOSS_LIMIT BUY: quote 잠금 = price × origQty (stopPrice 아님), registry 보관', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 10000);
    const h = makeService(db);

    await h.service.submitNewOrder(
      USER,
      dto({
        type: OrderType.STOP_LOSS_LIMIT,
        stopPrice: '52000',
        price: '52100',
        origQty: '0.1',
      }),
    );

    expect(wallet(db, 'USDT').locked.toFixed()).toBe('5210'); // 52100×0.1
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
    expect(h.registry.size()).toBe(1);
  });

  it('TAKE_PROFIT BUY (market-like stop): quote 잠금 = origQuoteQty, registry 보관', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 10000);
    const h = makeService(db);

    await h.service.submitNewOrder(
      USER,
      dto({ type: OrderType.TAKE_PROFIT, stopPrice: '48000', origQuoteQty: '5000' }),
    );

    expect(wallet(db, 'USDT').locked.toFixed()).toBe('5000');
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
    expect(h.registry.size()).toBe(1);
  });

  // ---------- placement: 거부 경로 ----------

  it('잔고 부족: 조건부 차감 0건 → INSUFFICIENT_BALANCE, 지갑/주문 무변동', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 4999); // lock 5000 필요
    const h = makeService(db);

    await expect(
      h.service.submitNewOrder(USER, dto({ price: '50000', origQty: '0.1' })),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_BALANCE });

    const w = wallet(db, 'USDT');
    expect(w.balance.toFixed()).toBe('4999');
    expect(w.locked.toFixed()).toBe('0');
    expect(db.orders.size).toBe(0);
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
    expect(h.userStream.emitExecutionReport).not.toHaveBeenCalled();
  });

  it('지갑 없음: WALLET_NOT_FOUND', async () => {
    const db = new FakePrisma();
    const h = makeService(db);

    await expect(
      h.service.submitNewOrder(USER, dto({ price: '50000', origQty: '0.1' })),
    ).rejects.toMatchObject({ code: ErrorCode.WALLET_NOT_FOUND });
    expect(db.orders.size).toBe(0);
  });

  it('티커 메타 없음: TICKER_NOT_FOUND', async () => {
    const db = new FakePrisma();
    const h = makeService(db);
    h.tickerStats.metaOf.mockReturnValue(null);

    await expect(
      h.service.submitNewOrder(USER, dto({ price: '50000', origQty: '0.1' })),
    ).rejects.toMatchObject({ code: ErrorCode.TICKER_NOT_FOUND });
  });

  it('minNotional 미달: MIN_NOTIONAL_NOT_MET, 잠금 없음', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 10000);
    const h = makeService(db);

    await expect(
      // 밴드 안(50000) + notional 5 < 10 → minNotional로 거부 (밴드 아님)
      h.service.submitNewOrder(USER, dto({ price: '50000', origQty: '0.0001' })),
    ).rejects.toMatchObject({ code: ErrorCode.MIN_NOTIONAL_NOT_MET });
    expect(wallet(db, 'USDT').locked.toFixed()).toBe('0');
  });

  // ---------- price band (PERCENT_PRICE ±10%) ----------

  it('밴드 초과 지정가 거부: PRICE_OUT_OF_BAND, 잠금 없음 (ref 50000, +10% 초과)', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 1_000_000);
    const h = makeService(db); // ref = 50000

    await expect(
      h.service.submitNewOrder(USER, dto({ price: '55001', origQty: '0.1' })), // +10.002%
    ).rejects.toMatchObject({ code: ErrorCode.PRICE_OUT_OF_BAND });
    expect(wallet(db, 'USDT').locked.toFixed()).toBe('0');
  });

  it('밴드 하한 초과 거부: PRICE_OUT_OF_BAND (ref 50000, -10% 미만)', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'BTC', 1);
    const h = makeService(db);

    await expect(
      h.service.submitNewOrder(USER, dto({ side: OrderSide.SELL, price: '44999', origQty: '0.1' })),
    ).rejects.toMatchObject({ code: ErrorCode.PRICE_OUT_OF_BAND });
  });

  it('밴드 경계(정확히 ±10%)는 통과 — gte/lte inclusive', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 1_000_000);
    const h = makeService(db);
    // 55000 = 50000 × 1.10 정확히 경계
    const order = (await h.service.submitNewOrder(
      USER,
      dto({ price: '55000', origQty: '0.1' }),
    )) as Order;
    expect(order.status).toBe('NEW');
  });

  it('기준가 없으면(avgPrice5m null + last null) 밴드 검사 생략', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 1_000_000);
    const h = makeService(db, { lastPrice: null }); // avgPrice5m mock도 null 반환
    const order = (await h.service.submitNewOrder(
      USER,
      dto({ price: '999999', origQty: '0.1' }),
    )) as Order;
    expect(order.status).toBe('NEW');
  });

  // ---------- MAX_NUM_ORDERS (per-symbol open-order cap) ----------

  it('심볼 오픈주문 상한 도달 시 신규 주문 거부: MAX_NUM_ORDERS_EXCEEDED', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 100_000_000);
    // 상한(200)만큼 오픈 주문 시드
    for (let i = 0; i < 200; i++) {
      db.makeOrder({ userId: USER, price: d(50000), origQty: d('0.1'), status: 'OPEN' });
    }
    const h = makeService(db);

    await expect(
      h.service.submitNewOrder(USER, dto({ price: '50000', origQty: '0.1' })),
    ).rejects.toMatchObject({ code: ErrorCode.MAX_NUM_ORDERS_EXCEEDED });
    expect(wallet(db, 'USDT').locked.toFixed()).toBe('0');
  });

  it('상한 미만(199)에서는 통과', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 100_000_000);
    for (let i = 0; i < 199; i++) {
      db.makeOrder({ userId: USER, price: d(50000), origQty: d('0.1'), status: 'OPEN' });
    }
    const h = makeService(db);
    const order = (await h.service.submitNewOrder(
      USER,
      dto({ price: '50000', origQty: '0.1' }),
    )) as Order;
    expect(order.status).toBe('NEW');
  });

  it('cancel-replace는 교체 대상을 카운트에서 제외 — 상한에서도 성공', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 100_000_000);
    let old!: OrderRow;
    for (let i = 0; i < 200; i++) {
      const o = db.makeOrder({ userId: USER, price: d(50000), origQty: d('0.1'), status: 'OPEN' });
      if (i === 0) old = o;
    }
    const h = makeService(db);
    const res = await h.service.submitNewOrder(
      USER,
      dto({ price: '50000', origQty: '0.1', replacesOrderId: old.id }),
    );
    expect((res as { order: Order }).order.status).toBe('NEW');
  });

  it('즉시 트리거 충족 stop 거부: ORDER_WOULD_TRIGGER_IMMEDIATELY (SL SELL lte / TP BUY lte 경계 포함)', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'BTC', 1);
    db.seedWallet(USER, 'USDT', 10000);
    const h = makeService(db); // last 50000

    await expect(
      h.service.submitNewOrder(
        USER,
        dto({
          type: OrderType.STOP_LOSS,
          side: OrderSide.SELL,
          stopPrice: '50000',
          origQty: '0.1',
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ORDER_WOULD_TRIGGER_IMMEDIATELY });

    await expect(
      h.service.submitNewOrder(
        USER,
        dto({ type: OrderType.TAKE_PROFIT, stopPrice: '50000', origQuoteQty: '5000' }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ORDER_WOULD_TRIGGER_IMMEDIATELY });

    expect(wallet(db, 'BTC').locked.toFixed()).toBe('0');
    expect(wallet(db, 'USDT').locked.toFixed()).toBe('0');
  });

  it('체결 이력 전무(last null): 즉시 트리거 검사 생략 — stop 접수됨', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'BTC', 1);
    const h = makeService(db, { lastPrice: null }); // snapshot/trade 모두 없음

    const order = (await h.service.submitNewOrder(
      USER,
      dto({ type: OrderType.STOP_LOSS, side: OrderSide.SELL, stopPrice: '50000', origQty: '0.1' }),
    )) as Order;

    expect(order.status).toBe('NEW');
    expect(h.registry.size()).toBe(1);
  });

  it('타입별 필수/금지 필드 매트릭스: INVALID_ORDER_FIELDS', async () => {
    const db = new FakePrisma();
    const h = makeService(db);

    const bad: Partial<CreateOrderDto>[] = [
      { type: OrderType.LIMIT, origQty: '0.1' }, // price 누락
      { type: OrderType.LIMIT, price: '50000', origQty: '0.1', origQuoteQty: '5000' },
      { type: OrderType.LIMIT, price: '50000', origQty: '0.1', stopPrice: '48000' },
      { type: OrderType.MARKET, price: '50000', origQuoteQty: '5000' },
      { type: OrderType.MARKET, origQty: '0.1' }, // BUY는 origQuoteQty
      { type: OrderType.MARKET, side: OrderSide.SELL, origQuoteQty: '5000' }, // SELL은 origQty
      { type: OrderType.STOP_LOSS, side: OrderSide.SELL, origQty: '0.1' }, // stopPrice 누락
      { type: OrderType.STOP_LOSS_LIMIT, stopPrice: '52000', origQty: '0.1' }, // price 누락
      {
        type: OrderType.TAKE_PROFIT_LIMIT,
        stopPrice: '52000',
        price: '52100',
        origQty: '0.1',
        origQuoteQty: '1',
      },
    ];
    for (const over of bad) {
      await expect(h.service.submitNewOrder(USER, dto(over))).rejects.toMatchObject({
        code: ErrorCode.INVALID_ORDER_FIELDS,
      });
    }
    expect(db.orders.size).toBe(0);
  });

  // ---------- cancel: 검증 ----------

  it('취소 검증: 미존재 ORDER_NOT_FOUND / 타인 FORBIDDEN / terminal ORDER_NOT_OPEN', async () => {
    const db = new FakePrisma();
    const mine = db.makeOrder({
      userId: USER,
      price: d(50000),
      origQty: d('0.1'),
      status: 'FILLED',
    });
    const others = db.makeOrder({ userId: 'u2', price: d(50000), origQty: d('0.1') });
    const h = makeService(db);

    await expect(h.service.submitCancelOrder(USER, 'nope')).rejects.toMatchObject({
      code: ErrorCode.ORDER_NOT_FOUND,
    });
    await expect(h.service.submitCancelOrder(USER, others.id)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
    await expect(h.service.submitCancelOrder(USER, mine.id)).rejects.toMatchObject({
      code: ErrorCode.ORDER_NOT_OPEN,
      message: 'Order already FILLED',
    });
    expect(h.dispatch.dispatchCancelOrder).not.toHaveBeenCalled();
  });

  it('비stop open 주문 취소: 엔진 CO 전송, 로컬 상태/환불 없음', async () => {
    const db = new FakePrisma();
    const order = db.makeOrder({
      userId: USER,
      price: d(50000),
      origQty: d('0.1'),
      status: 'OPEN',
    });
    const h = makeService(db);

    await h.service.submitCancelOrder(USER, order.id);

    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
    expect((h.dispatch.dispatchCancelOrder.mock.calls[0] as [{ id: string }])[0].id).toBe(order.id);
    expect(db.orders.get(order.id)!.status).toBe('OPEN'); // 상태 전이는 OU에서
    expect(h.settlement.recordDustRefund).not.toHaveBeenCalled();
  });

  it('미트리거 stop 취소: guarded 로컬 취소 + 환불(settlement, eq=0/cqq=0, 동일 tx) + CO 미전송', async () => {
    const db = new FakePrisma();
    const order = db.makeOrder({
      userId: USER,
      type: 'STOP_LOSS',
      side: OrderSide.SELL,
      stopPrice: d(48000),
      origQty: d('0.1'),
    });
    const h = makeService(db);
    h.registry.add(order as never);

    const res = (await h.service.submitCancelOrder(USER, order.id)) as Order;

    expect(db.orders.get(order.id)!.status).toBe('CANCELED');
    expect(res.status).toBe('CANCELED');
    expect(h.registry.size()).toBe(0);
    expect(h.dispatch.dispatchCancelOrder).not.toHaveBeenCalled();
    expect(reportsOf(h, order.id)).toEqual([expect.objectContaining({ status: 'CANCELED' })]);

    // 환불 산식은 settlement 소유 — 호출 경계(인자/tx 합류)만 박제
    expect(h.settlement.recordDustRefund).toHaveBeenCalledTimes(1);
    const [params, tx] = h.settlement.recordDustRefund.mock.calls[0] as [
      {
        orderId: string;
        userId: string;
        baseAssetSymbol: string;
        quoteAssetSymbol: string;
        executedQty: Decimal;
        cumulativeQuoteQty: Decimal;
        origQty: Decimal | null;
      },
      unknown,
    ];
    expect(params).toMatchObject({
      orderId: order.id,
      userId: USER,
      baseAssetSymbol: 'BTC',
      quoteAssetSymbol: 'USDT',
      side: OrderSide.SELL,
    });
    expect(params.executedQty.toFixed()).toBe('0');
    expect(params.cumulativeQuoteQty.toFixed()).toBe('0');
    expect(params.origQty!.toFixed()).toBe('0.1');
    expect(tx).toBe(db); // claim과 환불 INSERT 동일 트랜잭션
  });

  it('이미 트리거된 stop 취소: 로컬 경로 스킵 → 엔진 CO, 환불 없음', async () => {
    const db = new FakePrisma();
    const order = db.makeOrder({
      userId: USER,
      type: 'STOP_LOSS',
      side: OrderSide.SELL,
      stopPrice: d(48000),
      origQty: d('0.1'),
      triggeredAt: new Date(),
    });
    const h = makeService(db);

    await h.service.submitCancelOrder(USER, order.id);

    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
    expect(db.orders.get(order.id)!.status).toBe('NEW');
    expect(h.settlement.recordDustRefund).not.toHaveBeenCalled();
  });

  it('stop 취소 claim 패배(status≠NEW): 로컬 취소 포기 → 엔진 CO 폴백', async () => {
    const db = new FakePrisma();
    // 미트리거 형태지만 status가 NEW가 아님 — guarded claim 0건 경로
    const order = db.makeOrder({
      userId: USER,
      type: 'STOP_LOSS_LIMIT',
      side: OrderSide.SELL,
      price: d(47900),
      stopPrice: d(48000),
      origQty: d('0.1'),
      status: 'OPEN',
    });
    const h = makeService(db);

    await h.service.submitCancelOrder(USER, order.id);

    expect(db.orders.get(order.id)!.status).toBe('OPEN');
    expect(h.settlement.recordDustRefund).not.toHaveBeenCalled();
    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
  });

  it('OCO 레그 취소: 리스트 전체 취소로 라우팅', async () => {
    const db = new FakePrisma();
    const leg = db.makeOrder({
      userId: USER,
      price: d(52000),
      origQty: d('0.1'),
      orderListId: 'list-1',
    });
    const h = makeService(db);

    await h.service.submitCancelOrder(USER, leg.id);

    expect(h.orderLists.cancelList).toHaveBeenCalledWith(USER, 'list-1');
    expect(h.dispatch.dispatchCancelOrder).not.toHaveBeenCalled();
  });

  it('cancelAllOpen: 단일 주문은 개별 취소, OCO는 리스트당 1회 idempotent 취소', async () => {
    const db = new FakePrisma();
    const s1 = db.makeOrder({ userId: USER, price: d(50000), origQty: d('0.1') });
    const s2 = db.makeOrder({
      userId: USER,
      price: d(51000),
      origQty: d('0.1'),
      status: 'PARTIAL',
    });
    const leg1 = db.makeOrder({
      userId: USER,
      price: d(52000),
      origQty: d('0.1'),
      orderListId: 'L1',
    });
    const leg2 = db.makeOrder({
      userId: USER,
      type: 'STOP_LOSS_LIMIT',
      price: d(47900),
      stopPrice: d(48000),
      origQty: d('0.1'),
      orderListId: 'L1',
    });
    db.makeOrder({ userId: USER, price: d(50000), origQty: d('0.1'), status: 'FILLED' }); // terminal 제외
    db.makeOrder({ userId: 'u2', price: d(50000), origQty: d('0.1') }); // 타인 제외

    const h = makeService(db);
    const res = await h.service.cancelAllOpen(USER, MarketType.SPOT, SYM);

    expect(res.map((o) => o.id)).toEqual([s1.id, s2.id, leg1.id, leg2.id]);
    expect(h.orderLists.cancelList).toHaveBeenCalledTimes(1);
    expect(h.orderLists.cancelList).toHaveBeenCalledWith(USER, 'L1', { idempotent: true });
    const coIds = h.dispatch.dispatchCancelOrder.mock.calls.map(
      (c: unknown[]) => (c[0] as { id: string }).id,
    );
    expect(coIds.sort()).toEqual([s1.id, s2.id].sort());
  });

  // ---------- cancel-replace ----------

  it('replace 검증: 미존재/타인/terminal/OCO 레그/심볼 불일치 거부', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 100000);
    const others = db.makeOrder({ userId: 'u2', price: d(50000), origQty: d('0.1') });
    const filled = db.makeOrder({
      userId: USER,
      price: d(50000),
      origQty: d('0.1'),
      status: 'FILLED',
    });
    const leg = db.makeOrder({
      userId: USER,
      price: d(50000),
      origQty: d('0.1'),
      orderListId: 'L1',
    });
    const otherSym = db.makeOrder({
      userId: USER,
      tickerSymbol: 'ETHUSDT',
      price: d(3000),
      origQty: d('1'),
    });
    const h = makeService(db);
    const newDto = dto({ price: '50000', origQty: '0.1' });

    await expect(
      h.service.submitNewOrder(USER, { ...newDto, replacesOrderId: 'nope' }),
    ).rejects.toMatchObject({ code: ErrorCode.ORDER_NOT_FOUND });
    await expect(
      h.service.submitNewOrder(USER, { ...newDto, replacesOrderId: others.id }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    await expect(
      h.service.submitNewOrder(USER, { ...newDto, replacesOrderId: filled.id }),
    ).rejects.toMatchObject({ code: ErrorCode.ORDER_NOT_OPEN });
    await expect(
      h.service.submitNewOrder(USER, { ...newDto, replacesOrderId: leg.id }),
    ).rejects.toMatchObject({
      code: ErrorCode.ORDER_REPLACE_REJECTED,
      message: 'Cannot replace an OCO leg',
    });
    await expect(
      h.service.submitNewOrder(USER, { ...newDto, replacesOrderId: otherSym.id }),
    ).rejects.toMatchObject({ code: ErrorCode.ORDER_REPLACE_REJECTED });

    expect(wallet(db, 'USDT').locked.toFixed()).toBe('0'); // 검증 실패 시 잠금 없음
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
  });

  it('replace 성공: 신규 잠금+NO 먼저, 기존 CO — 잠금 일시 공존(로컬 환불 없음)', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 10000);
    const old = db.makeOrder({ userId: USER, price: d(49000), origQty: d('0.1') });
    const h = makeService(db);

    const res = await h.service.submitNewOrder(
      USER,
      dto({ price: '50000', origQty: '0.1', replacesOrderId: old.id }),
    );

    expect('replaced' in res).toBe(true);
    const { order, replaced } = res as { order: Order; replaced: object };
    expect(replaced).toEqual({ orderId: old.id, cancelRequested: true });
    expect(wallet(db, 'USDT').locked.toFixed()).toBe('5000'); // 신규 잠금만 (기존 환불은 OU 이후)
    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
    expect((h.dispatch.dispatchNewOrder.mock.calls[0] as [{ id: string }])[0].id).toBe(order.id);
    expect(h.dispatch.dispatchCancelOrder).toHaveBeenCalledTimes(1);
    expect((h.dispatch.dispatchCancelOrder.mock.calls[0] as [{ id: string }])[0].id).toBe(old.id);
    expect(h.settlement.recordDustRefund).not.toHaveBeenCalled();
  });

  it('replace 대상이 미트리거 stop: 신규 배치 후 기존은 로컬 취소+환불', async () => {
    const db = new FakePrisma();
    db.seedWallet(USER, 'USDT', 10000);
    const old = db.makeOrder({
      userId: USER,
      type: 'STOP_LOSS_LIMIT',
      price: d(52100),
      stopPrice: d(52000),
      origQty: d('0.1'),
    });
    const h = makeService(db);

    const res = await h.service.submitNewOrder(
      USER,
      dto({ price: '50000', origQty: '0.1', replacesOrderId: old.id }),
    );

    expect('replaced' in res).toBe(true);
    expect(db.orders.get(old.id)!.status).toBe('CANCELED');
    expect(h.settlement.recordDustRefund).toHaveBeenCalledTimes(1);
    expect(h.dispatch.dispatchCancelOrder).not.toHaveBeenCalled();
    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
  });
});
