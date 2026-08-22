import { MarginMode, OrderStatus, PositionStatus, SettlementKind } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { Op } from '@app/infra/messaging/topics';
import { isLiquidationTarget, LiquidationMonitor } from './liquidation.monitor';
import { LiquidationExecutor } from './liquidation-executor';

// 청산 모니터 가드레일 — 판정 경계, claim 경합, 재진입 중복 NO 방지, takeover legs 형식

const d = (v: string | number) => new Decimal(v);

function callsOf<T extends unknown[]>(fn: jest.Mock): T[] {
  return fn.mock.calls as unknown as T[];
}
const SYM = 'BTCUSDT';
const FUND = 'fund-user';
const MMR = d('0.005');

function position(over: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 'A',
    tickerSymbol: SYM,
    tickerMarket: 'FUTURES',
    qty: d(1),
    entryPrice: d(50000),
    isolatedMargin: d(5000),
    leverage: 10,
    marginMode: MarginMode.ISOLATED,
    status: PositionStatus.LIQUIDATING,
    updatedAt: new Date(),
    ...over,
  };
}

interface FakePrisma {
  position: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  order: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
  };
  trade: { count: jest.Mock };
  settlementEvent: { findFirst: jest.Mock; count: jest.Mock; create: jest.Mock };
  ticker: { findUnique: jest.Mock };
  wallet: { findUnique: jest.Mock };
}

function makeMonitor(over: { mark?: Decimal } = {}) {
  const prisma: FakePrisma = {
    position: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    order: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    trade: { count: jest.fn().mockResolvedValue(0) },
    settlementEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({}),
    },
    ticker: { findUnique: jest.fn().mockResolvedValue({ partition: 3 }) },
    wallet: { findUnique: jest.fn().mockResolvedValue({ balance: d(0) }) },
  };
  const kafka = { emit: jest.fn().mockResolvedValue(undefined) };
  const userEvents = { emitPositionUpdate: jest.fn(), emitMarginCall: jest.fn() };
  // 기본 mark 45000 — 롱 50000 진입 포지션이 청산 대상으로 판정되는 값
  const markPrice = {
    onMark: jest.fn(),
    getMark: jest.fn(() => over.mark ?? d(45000)),
    tryGetMark: jest.fn(() => over.mark ?? d(45000)),
  };
  const futuresConfig = { configOf: jest.fn().mockResolvedValue({ mmr: MMR }) };
  const tickerStats = { metaOf: jest.fn(() => ({ quoteAsset: 'USDT' })) };
  const executor = new LiquidationExecutor(
    prisma as never,
    kafka as never,
    futuresConfig as never,
    markPrice as never,
    userEvents as never,
    tickerStats as never,
  );
  const monitor = new LiquidationMonitor(
    prisma as never,
    futuresConfig as never,
    markPrice as never,
    { userId: jest.fn().mockResolvedValue(FUND) } as never,
    executor,
    userEvents as never,
  );
  return { monitor, prisma, kafka, userEvents, markPrice, executor };
}

describe('isLiquidationTarget — marginRatio 판정 경계', () => {
  // 롱 1 BTC EP 50000, mark 49000: MM = ceil8(0.005×49000) = 245, UPNL = −1000
  const mark = d(49000);

  it('marginRatio == 1 (equity == MM)이면 대상', () => {
    expect(isLiquidationTarget(position({ isolatedMargin: d(1245) }) as never, mark, MMR)).toBe(
      true,
    );
  });

  it('marginRatio < 1 (equity가 MM보다 1단위라도 크면) 비대상', () => {
    expect(
      isLiquidationTarget(position({ isolatedMargin: d('1245.00000001') }) as never, mark, MMR),
    ).toBe(false);
  });

  it('분모(margin + UPNL) == 0이면 즉시 대상', () => {
    expect(isLiquidationTarget(position({ isolatedMargin: d(1000) }) as never, mark, MMR)).toBe(
      true,
    );
  });

  it('분모 < 0이면 즉시 대상', () => {
    expect(isLiquidationTarget(position({ isolatedMargin: d(999) }) as never, mark, MMR)).toBe(
      true,
    );
  });

  it('숏 경계: qty=−1 EP 50000, mark 51000 → MM 255, UPNL −1000', () => {
    const short = (margin: string | number) => position({ qty: d(-1), isolatedMargin: d(margin) });
    expect(isLiquidationTarget(short(1255) as never, d(51000), MMR)).toBe(true); // ratio == 1
    expect(isLiquidationTarget(short(1256) as never, d(51000), MMR)).toBe(false);
  });

  it('건전 포지션/qty 0은 비대상', () => {
    expect(isLiquidationTarget(position() as never, d(50000), MMR)).toBe(false);
    expect(isLiquidationTarget(position({ qty: d(0) }) as never, d(1), MMR)).toBe(false);
  });
});

describe('sweep — guarded claim', () => {
  const breaching = position({ status: PositionStatus.NORMAL, isolatedMargin: d(100) });

  it('claim 경합(count 0)이면 시퀀스를 시작하지 않는다', async () => {
    const { monitor, prisma, kafka } = makeMonitor();
    prisma.position.findMany.mockResolvedValue([breaching]);
    prisma.position.updateMany.mockResolvedValue({ count: 0 }); // 선점자 존재
    const liquidate = jest.spyOn(monitor, 'liquidate').mockResolvedValue(undefined);

    await monitor.sweep(SYM, d(49000));

    expect(prisma.position.updateMany).toHaveBeenCalledWith({
      where: { userId: 'A', tickerSymbol: SYM, status: PositionStatus.NORMAL },
      data: { status: PositionStatus.LIQUIDATING },
    });
    expect(liquidate).not.toHaveBeenCalled();
    expect(kafka.emit).not.toHaveBeenCalled();
  });

  it('claim 성공(count 1)이면 재검증 후 시퀀스 시작 — 보험기금은 조회에서 제외, 전이는 fuser로 통지', async () => {
    const { monitor, prisma, userEvents } = makeMonitor({ mark: d(49000) });
    prisma.position.findMany.mockResolvedValue([breaching]);
    prisma.position.findUnique.mockResolvedValue(position({ isolatedMargin: d(100) }));
    const liquidate = jest.spyOn(monitor, 'liquidate').mockResolvedValue(undefined);

    await monitor.sweep(SYM, d(49000));

    expect(prisma.position.findMany).toHaveBeenCalledWith({
      where: {
        tickerSymbol: SYM,
        status: PositionStatus.NORMAL,
        qty: { not: d(0) },
        marginMode: MarginMode.ISOLATED,
        userId: { not: FUND },
      },
    });
    expect(liquidate).toHaveBeenCalledTimes(1);
    expect(liquidate).toHaveBeenCalledWith('A', SYM);
    expect(userEvents.emitPositionUpdate).toHaveBeenCalledWith('A', [
      expect.objectContaining({ symbol: SYM, status: PositionStatus.LIQUIDATING }),
    ]);
  });

  it('claim 직후 재검증: 그 사이 건전해진 포지션은 시퀀스 없이 NORMAL 복귀', async () => {
    const { monitor, prisma } = makeMonitor({ mark: d(49000) });
    prisma.position.findMany.mockResolvedValue([breaching]);
    // claim 직전 마진 추가로 회복 — equity 5000 > MM 245
    prisma.position.findUnique.mockResolvedValue(position({ isolatedMargin: d(6000) }));
    const liquidate = jest.spyOn(monitor, 'liquidate').mockResolvedValue(undefined);

    await monitor.sweep(SYM, d(49000));

    expect(liquidate).not.toHaveBeenCalled();
    expect(prisma.position.updateMany).toHaveBeenCalledWith({
      where: { userId: 'A', tickerSymbol: SYM, status: PositionStatus.LIQUIDATING },
      data: { status: PositionStatus.NORMAL },
    });
  });

  it('잔존 LIQUIDATING이 있으면 판정 없이 재진입한다', async () => {
    const { monitor, prisma } = makeMonitor();
    prisma.position.findFirst.mockResolvedValue(position({ userId: 'B' }));
    const liquidate = jest.spyOn(monitor, 'liquidate').mockResolvedValue(undefined);

    await monitor.sweep(SYM, d(49000));

    expect(liquidate).toHaveBeenCalledWith('B', SYM);
    expect(prisma.position.findMany).not.toHaveBeenCalled();
  });
});

describe('liquidate — 시퀀스', () => {
  it('정상 경로: 잔여 qty로 IOC MARKET liquidation NO 발행, 잔존 시 takeover append', async () => {
    const { monitor, prisma, kafka } = makeMonitor();
    // open LIMIT 주문 1건 → CO 발행 대상
    const openOrder = { id: 'o1', userId: 'A', tickerSymbol: SYM };
    prisma.order.findMany.mockResolvedValue([openOrder]);
    // drain watermark 경유 (PENDING 1건 → 적용 완료)
    prisma.settlementEvent.findFirst.mockResolvedValueOnce({ seq: 42 });
    prisma.settlementEvent.count.mockResolvedValue(0);
    prisma.position.findUnique
      .mockResolvedValueOnce(position({ qty: d('1.5') })) // NO 발행 전
      .mockResolvedValueOnce(position({ qty: d('0.5') })); // IOC 부분체결 잔여
    prisma.order.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'liq-1',
        ...data,
        price: null,
        origQuoteQty: null,
        executedQty: d(0),
        cumulativeQuoteQty: d(0),
      }),
    );
    prisma.order.findUnique.mockResolvedValue({ status: OrderStatus.EXPIRED });

    await monitor.liquidate('A', SYM);

    // CO 1건 + NO 1건
    expect(kafka.emit).toHaveBeenCalledTimes(2);
    const emits = callsOf<[string, number, Record<string, unknown>]>(kafka.emit);
    expect(emits[0][2]).toMatchObject({ op: Op.CANCEL_ORDER, id: 'o1' });
    expect(emits[1][2]).toMatchObject({
      op: Op.NEW_ORDER,
      id: 'liq-1',
      u: 'A',
      s: SYM,
      t: 'M',
      sd: 'S', // 롱 청산은 SELL
      tif: 'I',
      oq: '150000000', // 1.5 × 10^8
    });
    const [orderCreate] = callsOf<[{ data: Record<string, unknown> }]>(prisma.order.create)[0];
    expect(orderCreate.data).toMatchObject({
      liquidation: true,
      reduceOnly: false,
      lockedCost: d(0),
      type: 'MARKET',
      timeInForce: 'IOC',
      origQty: d('1.5'),
    });

    // 잔존 0.5 → worker가 기대하는 모니터 형식 legs로 takeover append
    expect(prisma.settlementEvent.create).toHaveBeenCalledTimes(1);
    const [created] = callsOf<
      [{ data: { sourceKey: string; kind: string; legs: unknown; orderLegs: unknown } }]
    >(prisma.settlementEvent.create)[0];
    expect(created.data.kind).toBe(SettlementKind.LIQUIDATION_TAKEOVER);
    expect(created.data.sourceKey).toMatch(/^takeover:A:BTCUSDT:[0-9a-f-]{36}$/);
    expect(created.data.legs).toEqual([{ userId: 'A', symbol: SYM }]);
    expect(created.data.orderLegs).toEqual([]);
    // NORMAL 복귀는 worker의 takeover apply 몫 — 모니터는 건드리지 않는다
    expect(prisma.position.updateMany).not.toHaveBeenCalled();
  });

  it('재진입: OPEN liquidation 주문이 이미 있으면 NO를 재발행하지 않는다', async () => {
    const { monitor, prisma, kafka } = makeMonitor({ mark: d(53000) }); // 숏 −2 EP 50000 → 대상
    prisma.position.findUnique
      .mockResolvedValueOnce(position({ qty: d(-2) })) // 숏 잔존
      .mockResolvedValue(position({ qty: d(0) })); // 기존 NO 체결로 종결
    prisma.order.findFirst.mockResolvedValue({
      id: 'liq-prev',
      status: OrderStatus.NEW,
      createdAt: new Date(), // grace 미경과 — 엔진 미도달로 간주하지 않는다
      executedQty: d(0),
      lockedCost: d(0),
    });
    prisma.order.findUnique.mockResolvedValue({ status: OrderStatus.FILLED });

    await monitor.liquidate('A', SYM);

    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(kafka.emit).not.toHaveBeenCalled();
    // 기존 주문(liq-prev)의 terminal을 따라간 뒤 qty 0 → NORMAL 복귀
    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'liq-prev' },
      select: { status: true },
    });
    expect(prisma.position.updateMany).toHaveBeenCalledWith({
      where: { userId: 'A', tickerSymbol: SYM, status: PositionStatus.LIQUIDATING },
      data: { status: PositionStatus.NORMAL },
    });
    expect(prisma.settlementEvent.create).not.toHaveBeenCalled();
  });

  it('재진입: 직전 청산 주문 OPEN이면 terminal까지 follow 후에야 drain·NO — 최신 qty로 발행', async () => {
    const { monitor, prisma } = makeMonitor({ mark: d(45000) });
    prisma.order.findFirst
      .mockResolvedValueOnce({
        id: 'liq-prev',
        status: OrderStatus.PARTIAL,
        createdAt: new Date(),
        executedQty: d(1),
        lockedCost: d(0),
      })
      .mockResolvedValue(null); // ensure의 OPEN 재사용 조회 — 이미 terminal
    prisma.order.findUnique.mockResolvedValue({ status: OrderStatus.EXPIRED });
    prisma.position.findUnique
      // 직전 체결 반영 후 잔여 — margin 소진 상태라 여전히 청산 대상
      .mockResolvedValueOnce(position({ qty: d('0.5'), isolatedMargin: d(100) }))
      .mockResolvedValue(position({ qty: d(0) }));
    prisma.order.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'liq-2',
        ...data,
        price: null,
        origQuoteQty: null,
        executedQty: d(0),
        cumulativeQuoteQty: d(0),
      }),
    );

    await monitor.liquidate('A', SYM);

    // follow(terminal poll)가 drain 스냅샷보다 먼저 — 직전 체결 TR이 drain에 포함된다
    const firstTerminalPoll = prisma.order.findUnique.mock.invocationCallOrder[0];
    const firstDrainSnapshot = prisma.settlementEvent.findFirst.mock.invocationCallOrder[0];
    expect(firstTerminalPoll).toBeLessThan(firstDrainSnapshot);

    // NO는 stale 전량이 아니라 drain 후 잔여 0.5로 발행
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    const [created] = callsOf<[{ data: Record<string, unknown> }]>(prisma.order.create)[0];
    expect(created.data).toMatchObject({ origQty: d('0.5'), liquidation: true });
  });

  it('엔진 미도달 NEW 청산 주문(grace 경과·무체결): REJECTED 처리 후 새 NO 발행', async () => {
    const { monitor, prisma, kafka } = makeMonitor({ mark: d(53000) });
    prisma.order.findFirst
      .mockResolvedValueOnce({
        id: 'liq-stale',
        userId: 'A',
        status: OrderStatus.NEW,
        createdAt: new Date(Date.now() - 60_000),
        executedQty: d(0),
        lockedCost: d(0),
      })
      .mockResolvedValue(null);
    prisma.position.findUnique
      .mockResolvedValueOnce(position({ qty: d(-2) }))
      .mockResolvedValue(position({ qty: d(0) }));
    prisma.order.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'liq-new',
        ...data,
        price: null,
        origQuoteQty: null,
        executedQty: d(0),
        cumulativeQuoteQty: d(0),
      }),
    );
    prisma.order.findUnique.mockResolvedValue({ status: OrderStatus.FILLED });

    await monitor.liquidate('A', SYM);

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'liq-stale', status: OrderStatus.NEW },
      data: { status: OrderStatus.REJECTED },
    });
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    const noEmits = callsOf<[string, number, { op: string; id: string }]>(kafka.emit).filter(
      ([, , msg]) => msg.op === Op.NEW_ORDER,
    );
    expect(noEmits).toHaveLength(1);
    expect(noEmits[0][2].id).toBe('liq-new');
    // lockedCost 0 — 환불 이벤트 없음
    expect(prisma.settlementEvent.create).not.toHaveBeenCalled();
  });

  it('NO emit 실패: 주문을 REJECTED로 마킹 후 rethrow — 잔존 NEW 무한 재사용 차단', async () => {
    const { monitor, prisma, kafka } = makeMonitor({ mark: d(45000) });
    prisma.position.findUnique.mockResolvedValue(position({ qty: d('1.5') }));
    prisma.order.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'liq-fail',
        ...data,
        price: null,
        origQuoteQty: null,
        executedQty: d(0),
        cumulativeQuoteQty: d(0),
      }),
    );
    kafka.emit.mockRejectedValue(new Error('broker unavailable'));

    await expect(monitor.liquidate('A', SYM)).rejects.toThrow('broker unavailable');

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'liq-fail', status: OrderStatus.NEW },
      data: { status: OrderStatus.REJECTED },
    });
  });

  it('drain 후 재판정: 그 사이 건전해진 포지션은 NO 없이 NORMAL 복귀', async () => {
    const { monitor, prisma, kafka, userEvents } = makeMonitor({ mark: d(50000) }); // 회복된 mark
    prisma.position.findUnique.mockResolvedValue(position({ qty: d('1.5') })); // margin 5000 — 건전

    await monitor.liquidate('A', SYM);

    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(kafka.emit).not.toHaveBeenCalled();
    expect(prisma.settlementEvent.create).not.toHaveBeenCalled();
    expect(prisma.position.updateMany).toHaveBeenCalledWith({
      where: { userId: 'A', tickerSymbol: SYM, status: PositionStatus.LIQUIDATING },
      data: { status: PositionStatus.NORMAL },
    });
    expect(userEvents.emitPositionUpdate).toHaveBeenCalled();
  });

  it('waitOrdersTerminal timeout: 엔진 미도달 NEW 유저 주문을 REJECTED + 환불 후 throw', async () => {
    jest.useFakeTimers();
    try {
      const { monitor, prisma } = makeMonitor();
      const staleOrder = {
        id: 'uo1',
        userId: 'A',
        tickerSymbol: SYM,
        status: OrderStatus.NEW,
        createdAt: new Date(0),
        executedQty: d(0),
        lockedCost: d(100),
      };
      prisma.order.findMany.mockResolvedValue([staleOrder]);
      prisma.order.count.mockResolvedValue(1); // 영원히 open — timeout 경로

      const liquidation = monitor.liquidate('A', SYM);
      const failure = expect(liquidation).rejects.toThrow('not terminal within');
      await jest.advanceTimersByTimeAsync(11_000);
      await failure;

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'uo1', status: OrderStatus.NEW },
        data: { status: OrderStatus.REJECTED },
      });
      // consume의 terminal 환불과 동일 sourceKey — 늦은 OU 도착 시에도 멱등
      expect(prisma.settlementEvent.create).toHaveBeenCalledTimes(1);
      const [refund] = callsOf<[{ data: { sourceKey: string; kind: string; legs: unknown } }]>(
        prisma.settlementEvent.create,
      )[0];
      expect(refund.data.sourceKey).toBe('frefund:uo1');
      expect(refund.data.kind).toBe(SettlementKind.FUTURES_REFUND);
      expect(refund.data.legs).toEqual([{ orderId: 'uo1', userId: 'A', finalExecutedQty: '0' }]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drain 후 qty 0이면 NO 없이 NORMAL 복귀', async () => {
    const { monitor, prisma, kafka } = makeMonitor();
    prisma.position.findUnique.mockResolvedValue(position({ qty: d(0) }));

    await monitor.liquidate('A', SYM);

    expect(kafka.emit).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.position.updateMany).toHaveBeenCalledWith({
      where: { userId: 'A', tickerSymbol: SYM, status: PositionStatus.LIQUIDATING },
      data: { status: PositionStatus.NORMAL },
    });
  });

  it('drain 중 worker가 이미 NORMAL 복귀시켰으면 아무것도 하지 않는다', async () => {
    const { monitor, prisma, kafka } = makeMonitor();
    prisma.position.findUnique.mockResolvedValue(
      position({ qty: d(0), status: PositionStatus.NORMAL }),
    );

    await monitor.liquidate('A', SYM);

    expect(kafka.emit).not.toHaveBeenCalled();
    expect(prisma.position.updateMany).not.toHaveBeenCalled();
    expect(prisma.settlementEvent.create).not.toHaveBeenCalled();
  });
});

describe('sweepCross — 계정 단위 cross 청산', () => {
  const crossPos = (over: Partial<Record<string, unknown>> = {}) =>
    position({ marginMode: MarginMode.CROSS, status: PositionStatus.NORMAL, ...over });

  it('계정 위반이면 유저의 cross 포지션 전부 claim 후 집행', async () => {
    const { monitor, prisma, executor } = makeMonitor();
    prisma.position.findFirst.mockResolvedValue(null); // 잔존 cross 없음
    prisma.position.findMany.mockResolvedValue([crossPos()]);
    jest.spyOn(executor, 'isCrossAccountBreached').mockResolvedValue(true);
    const liq = jest.spyOn(executor, 'liquidateCross').mockResolvedValue(undefined);

    await monitor.sweepCross(SYM);

    expect(prisma.position.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'A',
        marginMode: MarginMode.CROSS,
        status: PositionStatus.NORMAL,
        qty: { not: d(0) },
      },
      data: { status: PositionStatus.LIQUIDATING },
    });
    expect(liq).toHaveBeenCalledWith('A');
  });

  it('계정 건전이면 claim·집행 없음', async () => {
    const { monitor, prisma, executor } = makeMonitor();
    prisma.position.findFirst.mockResolvedValue(null);
    prisma.position.findMany.mockResolvedValue([crossPos()]);
    jest.spyOn(executor, 'isCrossAccountBreached').mockResolvedValue(false);
    const liq = jest.spyOn(executor, 'liquidateCross').mockResolvedValue(undefined);

    await monitor.sweepCross(SYM);

    expect(prisma.position.updateMany).not.toHaveBeenCalled();
    expect(liq).not.toHaveBeenCalled();
  });

  it('claim 직후 재검증에서 회복되면 전 cross 포지션 NORMAL 복귀, 집행 없음', async () => {
    const { monitor, prisma, executor } = makeMonitor();
    prisma.position.findFirst.mockResolvedValue(null);
    prisma.position.findMany.mockResolvedValue([crossPos({ status: PositionStatus.LIQUIDATING })]);
    prisma.position.findUnique.mockResolvedValue(crossPos({ status: PositionStatus.LIQUIDATING }));
    jest
      .spyOn(executor, 'isCrossAccountBreached')
      .mockResolvedValueOnce(true) // 후보 평가
      .mockResolvedValueOnce(false); // claim 후 재검증 — 회복
    const liq = jest.spyOn(executor, 'liquidateCross').mockResolvedValue(undefined);

    await monitor.sweepCross(SYM);

    expect(prisma.position.updateMany).toHaveBeenCalledWith({
      where: { userId: 'A', tickerSymbol: SYM, status: PositionStatus.LIQUIDATING },
      data: { status: PositionStatus.NORMAL },
    });
    expect(liq).not.toHaveBeenCalled();
  });

  it('잔존 LIQUIDATING cross가 있으면 판정 없이 재진입', async () => {
    const { monitor, prisma, executor } = makeMonitor();
    prisma.position.findFirst.mockResolvedValue(
      crossPos({ userId: 'B', status: PositionStatus.LIQUIDATING }),
    );
    const breached = jest.spyOn(executor, 'isCrossAccountBreached');
    const liq = jest.spyOn(executor, 'liquidateCross').mockResolvedValue(undefined);

    await monitor.sweepCross(SYM);

    expect(liq).toHaveBeenCalledWith('B');
    expect(breached).not.toHaveBeenCalled();
    expect(prisma.position.findMany).not.toHaveBeenCalled();
  });
});

describe('scanMarginCalls — MARGIN_CALL 경고 디바운스', () => {
  // sweep/sweepCross는 비워두고 warn 스캔만 검증 — tick(private) 경유.
  const runTick = (monitor: LiquidationMonitor, mark: Decimal) =>
    (monitor as unknown as { tick(s: string, m: Decimal): Promise<void> }).tick(SYM, mark);

  // findMany를 where 인지형으로 — isolated 스캔/cross 후보/crossAccountPositions를 분기.
  function wireFindMany(
    prisma: ReturnType<typeof makeMonitor>['prisma'],
    rows: { isolated?: unknown[]; crossUsers?: { userId: string }[]; crossAccount?: unknown[] },
  ) {
    prisma.position.findMany.mockImplementation((args: { where: Record<string, unknown> }) => {
      const where = args.where;
      if (where.marginMode === MarginMode.ISOLATED) return Promise.resolve(rows.isolated ?? []);
      if (where.tickerSymbol === SYM && where.marginMode === MarginMode.CROSS) {
        return Promise.resolve(rows.crossUsers ?? []); // tickerSymbol로 좁힌 후보 조회
      }
      return Promise.resolve(rows.crossAccount ?? []); // crossAccountPositions (전 심볼)
    });
  }

  function quietSweeps(monitor: LiquidationMonitor) {
    jest.spyOn(monitor, 'sweep').mockResolvedValue(false);
    jest.spyOn(monitor, 'sweepCross').mockResolvedValue(undefined);
  }

  // EP 50000 롱 1, mark 49000 → MM 245, UPNL −1000. equity = isolatedMargin − 1000.
  // isolatedMargin 1300 → equity 300 → ratio 0.8166 (warn 밴드). 5000 → ratio 0.061 (건전).
  const warnPos = position({ status: PositionStatus.NORMAL, isolatedMargin: d(1300) });
  const healthyPos = position({ status: PositionStatus.NORMAL, isolatedMargin: d(5000) });

  it('isolated: warn 밴드 진입 시 1회 송출, 같은 밴드 유지 시 중복 송출 없음', async () => {
    const { monitor, prisma, userEvents } = makeMonitor({ mark: d(49000) });
    quietSweeps(monitor);
    wireFindMany(prisma, { isolated: [warnPos] });

    await runTick(monitor, d(49000));
    await runTick(monitor, d(49000)); // 여전히 밴드 — 디바운스

    expect(userEvents.emitMarginCall).toHaveBeenCalledTimes(1);
    expect(userEvents.emitMarginCall).toHaveBeenCalledWith('A', {
      symbol: SYM,
      marginMode: MarginMode.ISOLATED,
      marginRatio: expect.stringMatching(/^0\.81/) as unknown as string,
      markPrice: '49000.00000000',
      ts: expect.any(Number) as unknown as number,
    });
  });

  it('isolated: 건전 복귀(ratio<0.8)면 플래그 해제 — 재진입 시 다시 송출', async () => {
    const { monitor, prisma, userEvents } = makeMonitor({ mark: d(49000) });
    quietSweeps(monitor);

    wireFindMany(prisma, { isolated: [warnPos] });
    await runTick(monitor, d(49000)); // warn
    wireFindMany(prisma, { isolated: [healthyPos] });
    await runTick(monitor, d(49000)); // 건전 — 플래그 해제
    wireFindMany(prisma, { isolated: [warnPos] });
    await runTick(monitor, d(49000)); // 재송출

    expect(userEvents.emitMarginCall).toHaveBeenCalledTimes(2);
  });

  it('isolated: 청산/종결로 포지션이 사라지면 플래그 정리 — 재진입 시 다시 송출', async () => {
    const { monitor, prisma, userEvents } = makeMonitor({ mark: d(49000) });
    quietSweeps(monitor);

    wireFindMany(prisma, { isolated: [warnPos] });
    await runTick(monitor, d(49000)); // warn
    wireFindMany(prisma, { isolated: [] }); // 사라짐 — 플래그 정리
    await runTick(monitor, d(49000));
    wireFindMany(prisma, { isolated: [warnPos] });
    await runTick(monitor, d(49000)); // 다시 warn

    expect(userEvents.emitMarginCall).toHaveBeenCalledTimes(2);
  });

  it('청산 영역(ratio≥1)은 MARGIN_CALL 송출 안 함', async () => {
    const { monitor, prisma, userEvents } = makeMonitor({ mark: d(49000) });
    quietSweeps(monitor);
    // isolatedMargin 1245 → equity 245 == MM → ratio 1
    wireFindMany(prisma, {
      isolated: [position({ status: PositionStatus.NORMAL, isolatedMargin: d(1245) })],
    });

    await runTick(monitor, d(49000));

    expect(userEvents.emitMarginCall).not.toHaveBeenCalled();
  });

  it('cross: 계정 ratio가 warn 밴드면 유저당 1회 송출, 디바운스', async () => {
    const { monitor, prisma, userEvents, executor } = makeMonitor({ mark: d(49000) });
    quietSweeps(monitor);
    wireFindMany(prisma, {
      crossUsers: [{ userId: 'A' }],
      crossAccount: [position({ marginMode: MarginMode.CROSS })],
    });
    jest.spyOn(executor, 'crossAccountRatio').mockResolvedValue(d('0.85'));

    await runTick(monitor, d(49000));
    await runTick(monitor, d(49000)); // 디바운스 — 같은 밴드

    expect(userEvents.emitMarginCall).toHaveBeenCalledTimes(1);
    expect(userEvents.emitMarginCall).toHaveBeenCalledWith('A', {
      symbol: SYM,
      marginMode: MarginMode.CROSS,
      marginRatio: '0.85000000',
      markPrice: '49000.00000000',
      ts: expect.any(Number) as unknown as number,
    });
  });

  it('cross: 계정에 cross 포지션이 없으면 플래그 정리(송출 없음)', async () => {
    const { monitor, prisma, userEvents, executor } = makeMonitor({ mark: d(49000) });
    quietSweeps(monitor);
    wireFindMany(prisma, { crossUsers: [{ userId: 'A' }], crossAccount: [] });
    const ratio = jest.spyOn(executor, 'crossAccountRatio');

    await runTick(monitor, d(49000));

    expect(ratio).not.toHaveBeenCalled();
    expect(userEvents.emitMarginCall).not.toHaveBeenCalled();
  });
});
