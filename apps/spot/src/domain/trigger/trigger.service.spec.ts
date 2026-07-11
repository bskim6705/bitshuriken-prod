import { MarketType, OrderSide, TimeInForce } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService, TradeEvent } from '@app/core-domain/ticker/ticker-stats.service';
import { UserStreamService } from '../user-stream/user-stream.service';
import { OrderDispatchService } from '../order/order-dispatch.service';
import { OrderListService } from '../order-list/order-list.service';
import { TriggerRegistryService } from './trigger-registry.service';
import { TriggerService } from './trigger.service';

// TriggerService 박제 테스트 — 트리거 조건/guarded claim/부트 복구의 현재 동작을 고정한다 (코드 불변).

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

type Row = Record<string, unknown>;

// guarded updateMany의 where 절 평가 — 서비스가 쓰는 형태(동등/null/not)만 지원
function matchesWhere(row: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where)) {
    const cell = row[k];
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && !(v instanceof Decimal)) {
      const op = v as { not?: unknown };
      if (op.not !== undefined && cell === op.not) return false;
    } else if (v instanceof Date) {
      if (!(cell instanceof Date) || cell.getTime() !== v.getTime()) return false;
    } else if (cell !== v) {
      return false;
    }
  }
  return true;
}

class FakePrisma {
  orders = new Map<string, OrderRow>();
  /** settlementEvent.count 응답 시퀀스. undefined면 never-resolve — 부트 복구 파킹. */
  drainCounts: number[] | undefined;
  private seq = 0;

  order = {
    findMany: (args: { where: Row }) => {
      const rows = [...this.orders.values()].filter((o) =>
        matchesWhere(o as unknown as Row, args.where),
      );
      return Promise.resolve(rows.map((r) => ({ ...r })));
    },
    findUnique: (args: { where: { id: string } }) => {
      const row = this.orders.get(args.where.id);
      return Promise.resolve(row ? { ...row } : null);
    },
    updateMany: (args: { where: Row; data: Row }) => {
      let count = 0;
      for (const row of this.orders.values()) {
        if (matchesWhere(row as unknown as Row, args.where)) {
          Object.assign(row, args.data);
          count += 1;
        }
      }
      return Promise.resolve({ count });
    },
  };

  settlementEvent = {
    count: () => {
      if (this.drainCounts === undefined) return new Promise<number>(() => {});
      const v = this.drainCounts.length > 1 ? this.drainCounts.shift()! : this.drainCounts[0];
      return Promise.resolve(v);
    },
  };

  makeOrder(over: Partial<OrderRow> = {}): OrderRow {
    const row: OrderRow = {
      id: `order-${++this.seq}`,
      userId: USER,
      tickerSymbol: SYM,
      tickerMarket: MarketType.SPOT,
      type: 'STOP_LOSS',
      side: OrderSide.SELL,
      timeInForce: TimeInForce.GTC,
      price: null,
      stopPrice: d(48000),
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
}

function trade(price: string): TradeEvent {
  return {
    market: MarketType.SPOT,
    symbol: SYM,
    tradeId: 't',
    price: d(price),
    qty: d('0.01'),
    takerSide: OrderSide.BUY,
    ts: Date.now(),
  };
}

function makeService(db: FakePrisma) {
  let listener: ((e: TradeEvent) => void) | null = null;
  const tickerStats = {
    metaOf: jest.fn().mockReturnValue(META),
    onTrade: jest.fn((cb: (e: TradeEvent) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  };
  const userStream = { emitExecutionReport: jest.fn() };
  const registry = new TriggerRegistryService();
  const dispatch = {
    dispatchNewOrder: jest.fn().mockResolvedValue(undefined),
    dispatchCancelOrder: jest.fn().mockResolvedValue(undefined),
  };
  const orderLists = {
    onStopTriggered: jest.fn().mockResolvedValue(undefined),
    runBootRecovery: jest.fn().mockResolvedValue(undefined),
  };
  const service = new TriggerService(
    db as unknown as PrismaService,
    tickerStats as unknown as TickerStatsService,
    registry,
    dispatch as unknown as OrderDispatchService,
    orderLists as unknown as OrderListService,
    userStream as unknown as UserStreamService,
  );
  return {
    service,
    tickerStats,
    userStream,
    registry,
    dispatch,
    orderLists,
    emit: (e: TradeEvent) => listener?.(e),
    hasListener: () => listener !== null,
  };
}

type Harness = ReturnType<typeof makeService>;

/** onTrade의 void fire() 비동기 체인 drain (real timer 전용). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function dispatchedIds(fn: jest.Mock): string[] {
  return fn.mock.calls.map((c: unknown[]) => (c[0] as { id: string }).id);
}

async function bootstrap(h: Harness): Promise<void> {
  await h.service.onApplicationBootstrap();
}

describe('TriggerService (박제)', () => {
  // ---------- 트리거 조건 4종 ----------

  it('STOP_LOSS SELL: last ≤ stop에서 발화 (경계 포함), 초과 가격은 보류', async () => {
    const db = new FakePrisma();
    const order = db.makeOrder({ type: 'STOP_LOSS', side: OrderSide.SELL, stopPrice: d(48000) });
    const h = makeService(db);
    await bootstrap(h);

    h.emit(trade('48000.01')); // 미충족
    await flush();
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
    expect(h.registry.size()).toBe(1);

    h.emit(trade('48000')); // 경계 lte → 발화
    await flush();
    expect(db.orders.get(order.id)!.triggeredAt).toBeInstanceOf(Date);
    expect(db.orders.get(order.id)!.status).toBe('NEW'); // 상태는 NEW 유지, armed 표식만
    expect(dispatchedIds(h.dispatch.dispatchNewOrder)).toEqual([order.id]);
    expect(h.registry.size()).toBe(0);
    expect(h.userStream.emitExecutionReport).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ orderId: order.id, status: 'NEW' }),
    );
  });

  it('STOP_LOSS BUY: last ≥ stop에서 발화', async () => {
    const db = new FakePrisma();
    const order = db.makeOrder({
      type: 'STOP_LOSS_LIMIT',
      side: OrderSide.BUY,
      price: d(52100),
      stopPrice: d(52000),
    });
    const h = makeService(db);
    await bootstrap(h);

    h.emit(trade('51999.99'));
    await flush();
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();

    h.emit(trade('52000'));
    await flush();
    expect(dispatchedIds(h.dispatch.dispatchNewOrder)).toEqual([order.id]);
    expect(db.orders.get(order.id)!.triggeredAt).toBeInstanceOf(Date);
  });

  it('TAKE_PROFIT SELL: last ≥ stop에서 발화', async () => {
    const db = new FakePrisma();
    const order = db.makeOrder({ type: 'TAKE_PROFIT', side: OrderSide.SELL, stopPrice: d(52000) });
    const h = makeService(db);
    await bootstrap(h);

    h.emit(trade('51000'));
    await flush();
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();

    h.emit(trade('52000'));
    await flush();
    expect(dispatchedIds(h.dispatch.dispatchNewOrder)).toEqual([order.id]);
  });

  it('TAKE_PROFIT BUY: last ≤ stop에서 발화', async () => {
    const db = new FakePrisma();
    const order = db.makeOrder({
      type: 'TAKE_PROFIT',
      side: OrderSide.BUY,
      stopPrice: d(48000),
      origQty: null,
      origQuoteQty: d(5000),
    });
    const h = makeService(db);
    await bootstrap(h);

    h.emit(trade('49000'));
    await flush();
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();

    h.emit(trade('48000'));
    await flush();
    expect(dispatchedIds(h.dispatch.dispatchNewOrder)).toEqual([order.id]);
  });

  it('다른 심볼/시장 trade에는 무반응', async () => {
    const db = new FakePrisma();
    db.makeOrder({ stopPrice: d(48000) });
    const h = makeService(db);
    await bootstrap(h);

    h.emit({ ...trade('47000'), symbol: 'ETHUSDT' });
    await flush();
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
    expect(h.registry.size()).toBe(1);
  });

  // ---------- 이중 발화 방지 ----------

  it('동기 sweep 이중 발화 방지: 연속 trade에도 registry 제거가 동기라 발화 1회', async () => {
    const db = new FakePrisma();
    const order = db.makeOrder({ stopPrice: d(48000) });
    const h = makeService(db);
    await bootstrap(h);

    h.emit(trade('47000'));
    h.emit(trade('46000')); // flush 전 — 두 번째 sweep에는 후보 없음
    await flush();

    expect(dispatchedIds(h.dispatch.dispatchNewOrder)).toEqual([order.id]);
  });

  it('DB guarded claim 이중 발화 방지: 이미 armed면 claim 0 → 재전송/리포트 없음', async () => {
    const db = new FakePrisma();
    const order = db.makeOrder({ stopPrice: d(48000) });
    const h = makeService(db);
    await bootstrap(h);

    h.emit(trade('47000'));
    await flush();
    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);

    // registry에 stale 후보가 남아있던 상황 재현
    h.registry.add(order as never);
    h.emit(trade('47000'));
    await flush();

    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
    expect(h.userStream.emitExecutionReport).toHaveBeenCalledTimes(1);
    expect(h.registry.size()).toBe(0); // 후보는 소비됨
  });

  it('취소 레이스 패배: DB가 이미 CANCELED → claim 0, 발화 중단 (재등록도 없음)', async () => {
    const db = new FakePrisma();
    const order = db.makeOrder({ stopPrice: d(48000) });
    const h = makeService(db);
    await bootstrap(h);

    db.orders.get(order.id)!.status = 'CANCELED'; // 취소가 선점
    h.emit(trade('47000'));
    await flush();

    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
    expect(h.userStream.emitExecutionReport).not.toHaveBeenCalled();
    expect(db.orders.get(order.id)!.triggeredAt).toBeNull();
    expect(h.registry.size()).toBe(0);
  });

  it('OCO 레그 발화 실패: registry 복원 + 다음 trade에서 가격 무관 재발화(redrive=true)', async () => {
    const db = new FakePrisma();
    const leg = db.makeOrder({
      type: 'STOP_LOSS_LIMIT',
      price: d(47900),
      stopPrice: d(48000),
      orderListId: 'L1',
    });
    const h = makeService(db);
    await bootstrap(h);
    h.orderLists.onStopTriggered.mockRejectedValueOnce(new Error('kafka down'));

    h.emit(trade('47000'));
    await flush();
    expect(h.orderLists.onStopTriggered).toHaveBeenCalledTimes(1);
    expect(h.orderLists.onStopTriggered).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: leg.id }),
      false,
    );
    expect(h.registry.size()).toBe(1); // 복원됨

    h.emit(trade('49000')); // stop(48000) 미충족 가격 — 유실 복구는 가격 조건 없이 재발화
    await flush();
    expect(h.orderLists.onStopTriggered).toHaveBeenCalledTimes(2);
    expect(h.orderLists.onStopTriggered).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: leg.id }),
      true,
    );
    expect(h.registry.size()).toBe(0);
  });

  // ---------- NO 전송 실패 redrive (claim 유지 + 5s 주기 재전송) ----------

  describe('NO 전송 실패 redrive', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('전송 실패: claim 유지·registry 미복원, 5s 후 재전송 성공 + 리포트 1회', async () => {
      const db = new FakePrisma();
      const order = db.makeOrder({ stopPrice: d(48000) });
      const h = makeService(db);
      await bootstrap(h);
      h.dispatch.dispatchNewOrder.mockRejectedValueOnce(new Error('kafka down'));

      h.emit(trade('47000'));
      await flush();
      expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1); // 실패한 1회
      expect(db.orders.get(order.id)!.triggeredAt).toBeInstanceOf(Date); // claim 유지
      expect(h.registry.size()).toBe(0); // redrive 루프가 소유
      expect(h.userStream.emitExecutionReport).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(5_000);
      expect(dispatchedIds(h.dispatch.dispatchNewOrder)).toEqual([order.id, order.id]);
      expect(h.userStream.emitExecutionReport).toHaveBeenCalledTimes(1);
      expect(h.userStream.emitExecutionReport).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ orderId: order.id, status: 'NEW' }),
      );
    });

    it('재전송 연속 실패: 성공할 때까지 5s 간격 반복, 성공 후 루프 종료', async () => {
      const db = new FakePrisma();
      const order = db.makeOrder({ stopPrice: d(48000) });
      const h = makeService(db);
      await bootstrap(h);
      h.dispatch.dispatchNewOrder
        .mockRejectedValueOnce(new Error('kafka down'))
        .mockRejectedValueOnce(new Error('kafka down'));

      h.emit(trade('47000'));
      await flush();
      await jest.advanceTimersByTimeAsync(5_000); // 재시도 1 — 실패
      expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(5_000); // 재시도 2 — 성공
      expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(3);
      expect(dispatchedIds(h.dispatch.dispatchNewOrder).every((id) => id === order.id)).toBe(true);

      await jest.advanceTimersByTimeAsync(10_000); // 종료 확인 — 추가 전송 없음
      expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(3);
    });

    it('redrive 중단: 대기 중 status가 NEW를 벗어나면(취소/OU) 재전송 없음', async () => {
      const db = new FakePrisma();
      const order = db.makeOrder({ stopPrice: d(48000) });
      const h = makeService(db);
      await bootstrap(h);
      h.dispatch.dispatchNewOrder.mockRejectedValueOnce(new Error('kafka down'));

      h.emit(trade('47000'));
      await flush();
      db.orders.get(order.id)!.status = 'CANCELED';

      await jest.advanceTimersByTimeAsync(15_000);
      expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
      expect(h.userStream.emitExecutionReport).not.toHaveBeenCalled();
    });
  });

  // ---------- 라우팅 / 기타 ----------

  it('OCO 레그 트리거: OrderListService로 위임 — 직접 claim/NO 없음', async () => {
    const db = new FakePrisma();
    const leg = db.makeOrder({
      type: 'STOP_LOSS_LIMIT',
      price: d(47900),
      stopPrice: d(48000),
      orderListId: 'L1',
    });
    const h = makeService(db);
    await bootstrap(h);

    h.emit(trade('47000'));
    await flush();

    expect(h.orderLists.onStopTriggered).toHaveBeenCalledTimes(1);
    expect((h.orderLists.onStopTriggered.mock.calls[0] as [{ id: string }])[0].id).toBe(leg.id);
    expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();
    expect(db.orders.get(leg.id)!.triggeredAt).toBeNull(); // arming은 리스트 상태머신 소관
  });

  it('티커 메타 부재: NO는 전송하되 executionReport만 생략', async () => {
    const db = new FakePrisma();
    db.makeOrder({ stopPrice: d(48000) });
    const h = makeService(db);
    await bootstrap(h);
    h.tickerStats.metaOf.mockReturnValue(null);

    h.emit(trade('47000'));
    await flush();

    expect(h.dispatch.dispatchNewOrder).toHaveBeenCalledTimes(1);
    expect(h.userStream.emitExecutionReport).not.toHaveBeenCalled();
  });

  it('rehydrate: NEW+미트리거 stop만 registry 적재 (armed/terminal/비stop 제외)', async () => {
    const db = new FakePrisma();
    const pending = db.makeOrder({ stopPrice: d(48000) });
    db.makeOrder({ stopPrice: d(48000), triggeredAt: new Date() }); // armed 제외
    db.makeOrder({ stopPrice: d(48000), status: 'CANCELED' }); // terminal 제외
    db.makeOrder({ type: 'LIMIT', stopPrice: null, price: d(50000) }); // 비stop 제외
    const h = makeService(db);

    await bootstrap(h);

    expect(h.registry.size()).toBe(1);
    expect(h.registry.pendingFor(MarketType.SPOT, SYM)[0].id).toBe(pending.id);
  });

  it('onModuleDestroy: trade 구독 해제', async () => {
    const db = new FakePrisma();
    const h = makeService(db);
    await bootstrap(h);
    expect(h.hasListener()).toBe(true);

    h.service.onModuleDestroy();
    expect(h.hasListener()).toBe(false);
  });

  // ---------- 부트 복구 (10s 지연·status 재확인) ----------

  describe('boot recovery', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('armed-but-unsent: drain 후 10s 지연 뒤 NO 재전송 + OCO 복구 위임 (10s 전엔 무전송)', async () => {
      const db = new FakePrisma();
      db.drainCounts = [0];
      const armed = db.makeOrder({ stopPrice: d(48000), triggeredAt: new Date() });
      db.makeOrder({ stopPrice: d(48000), triggeredAt: new Date(), orderListId: 'L1' }); // OCO 제외
      db.makeOrder({ stopPrice: d(48000) }); // 미트리거 제외
      const h = makeService(db);

      await bootstrap(h);
      await jest.advanceTimersByTimeAsync(9_999);
      expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(dispatchedIds(h.dispatch.dispatchNewOrder)).toEqual([armed.id]);
      expect(h.orderLists.runBootRecovery).toHaveBeenCalledTimes(1);
    });

    it('status 재확인: 지연 중 OU로 status가 바뀐 주문은 재전송에서 자연 제외', async () => {
      const db = new FakePrisma();
      db.drainCounts = [0];
      const a = db.makeOrder({ stopPrice: d(48000), triggeredAt: new Date() });
      const b = db.makeOrder({ stopPrice: d(48000), triggeredAt: new Date() });
      const h = makeService(db);

      await bootstrap(h);
      await jest.advanceTimersByTimeAsync(5_000);
      db.orders.get(b.id)!.status = 'FILLED'; // Kafka 백로그 OU 처리됨
      await jest.advanceTimersByTimeAsync(5_000);

      expect(dispatchedIds(h.dispatch.dispatchNewOrder)).toEqual([a.id]);
    });

    it('settlement drain 대기: PENDING이 빠질 때까지 500ms 폴링 후 진행', async () => {
      const db = new FakePrisma();
      db.drainCounts = [3, 0]; // 1회차 3건 → 500ms 후 0건
      const armed = db.makeOrder({ stopPrice: d(48000), triggeredAt: new Date() });
      const h = makeService(db);

      await bootstrap(h);
      await jest.advanceTimersByTimeAsync(10_400); // 500(poll) + 10000(delay) 직전
      expect(h.dispatch.dispatchNewOrder).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(100);
      expect(dispatchedIds(h.dispatch.dispatchNewOrder)).toEqual([armed.id]);
    });

    it('drain 타임아웃(60s): PENDING이 안 빠져도 경고 후 복구 진행', async () => {
      const db = new FakePrisma();
      db.drainCounts = [5]; // 항상 PENDING 5건
      const armed = db.makeOrder({ stopPrice: d(48000), triggeredAt: new Date() });
      const h = makeService(db);

      await bootstrap(h);
      await jest.advanceTimersByTimeAsync(80_000); // 60s 타임아웃 + 10s 지연 경과

      expect(dispatchedIds(h.dispatch.dispatchNewOrder)).toEqual([armed.id]);
      expect(h.orderLists.runBootRecovery).toHaveBeenCalledTimes(1);
    });
  });
});
