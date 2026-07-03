import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { FuturesConfigService } from '../config/futures-config.service';
import { MarkPriceService } from '../mark-price/mark-price.service';
import { InsuranceFundService } from '../settlement/insurance-fund.service';
import { FundingLeg } from '../settlement/futures-settlement.types';
import { fundingPayment } from '../math/position-math';
import { buildFundingBatch, computeFundingRate } from './funding-math';
import { FundingScheduler } from './funding.scheduler';

// 펀딩 스케줄러 가드레일 — rate 클램프 경계, zero-sum dust, 멱등 skip.

const d = (v: string | number) => new Decimal(v);
const SYM = 'BTCUSDT';
const FUND = 'fund-user';

interface RateRow {
  tickerSymbol: string;
  fundingTime: Date;
  rate: Decimal;
  markPrice: Decimal;
}

interface EventRow {
  sourceKey: string;
  kind: string;
  legs: FundingLeg[];
}

class FakeDb {
  rates: RateRow[] = [];
  events: EventRow[] = [];
  positionRows: { userId: string; qty: Decimal }[] = [];
  failRateCreates = 0; // 일시 오류 시뮬레이션 — 남은 횟수만큼 create가 transient 실패

  ticker = { findMany: () => Promise.resolve([{ symbol: SYM }]) };

  fundingRate = {
    create: (args: { data: RateRow }) => {
      if (this.failRateCreates > 0) {
        this.failRateCreates--;
        return Promise.reject(new Error('transient db error'));
      }
      const dup = this.rates.some(
        (r) =>
          r.tickerSymbol === args.data.tickerSymbol &&
          r.fundingTime.getTime() === args.data.fundingTime.getTime(),
      );
      if (dup) {
        return Promise.reject(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        );
      }
      this.rates.push({ ...args.data });
      return Promise.resolve(args.data);
    },
  };

  position = {
    findMany: () => Promise.resolve(this.positionRows.map((p) => ({ ...p }))),
  };

  settlementEvent = {
    create: (args: { data: { sourceKey: string; kind: string; legs: unknown } }) => {
      if (this.events.some((e) => e.sourceKey === args.data.sourceKey)) {
        return Promise.reject(new Error(`duplicate sourceKey ${args.data.sourceKey}`));
      }
      this.events.push({
        sourceKey: args.data.sourceKey,
        kind: args.data.kind,
        legs: args.data.legs as FundingLeg[],
      });
      return Promise.resolve(args.data);
    },
  };

  async $transaction(fn: (tx: this) => Promise<void>): Promise<void> {
    const rates = [...this.rates];
    const events = [...this.events];
    try {
      await fn(this);
    } catch (e) {
      this.rates = rates;
      this.events = events;
      throw e;
    }
  }
}

function makeScheduler(db: FakeDb, over: { mark?: Decimal; samples?: Decimal[] } = {}) {
  const markPrice = {
    getMark: jest.fn(() => over.mark ?? d(50000)),
    drainPremiumSamples: jest.fn(() => over.samples ?? []),
  };
  const config = { configOf: jest.fn().mockResolvedValue({ fundingCap: d('0.003') }) };
  const fund = { userId: jest.fn().mockResolvedValue(FUND) };
  const scheduler = new FundingScheduler(
    db as unknown as PrismaService,
    markPrice as unknown as MarkPriceService,
    config as unknown as FuturesConfigService,
    fund as unknown as InsuranceFundService,
  );
  return { scheduler, markPrice };
}

describe('computeFundingRate', () => {
  const cap = d('0.003');

  it('샘플 0개 → clamp(이자율 0.01%, ±cap)', () => {
    expect(computeFundingRate([], cap).toFixed()).toBe('0.0001');
    expect(computeFundingRate([], d('0.00005')).toFixed()).toBe('0.00005');
  });

  it('avgP가 이자율 ±0.05% 이내면 rate == 이자율', () => {
    expect(computeFundingRate([d('0.0004')], cap).toFixed()).toBe('0.0001');
    expect(computeFundingRate([d('-0.0003')], cap).toFixed()).toBe('0.0001');
  });

  it('premium 보정 클램프: 이자율과 0.05% 초과 괴리 시 avgP ∓ 0.0005', () => {
    expect(computeFundingRate([d('0.001')], cap).toFixed()).toBe('0.0005');
    expect(computeFundingRate([d('-0.001')], cap).toFixed()).toBe('-0.0005');
  });

  it('fundingCap 경계: 초과는 ±cap 클램프, 정확히 cap이면 그대로', () => {
    expect(computeFundingRate([d('0.01')], cap).toFixed()).toBe('0.003');
    expect(computeFundingRate([d('-0.01')], cap).toFixed()).toBe('-0.003');
    expect(computeFundingRate([d('0.0035')], cap).toFixed()).toBe('0.003'); // pre-cap == cap
  });

  it('avgP는 샘플 산술평균', () => {
    // avg(0.002, 0.004) = 0.003 → 0.003 − 0.0005 = 0.0025
    expect(computeFundingRate([d('0.002'), d('0.004')], cap).toFixed()).toBe('0.0025');
  });
});

describe('buildFundingBatch', () => {
  it('zero-sum: floor 라운딩 dust는 양수(기금 수령)로 귀속, 배치 지급 총합 0', () => {
    const rate = d('0.0001');
    const mark = d('33333.33333333');
    const batch = buildFundingBatch(
      SYM,
      rate,
      mark,
      [
        { userId: 'A', qty: d('0.003') },
        { userId: 'B', qty: d('-0.001') },
        { userId: 'C', qty: d('-0.002') },
      ],
      FUND,
    );

    expect(batch.dustLeg).not.toBeNull();
    expect(batch.dustLeg!.userId).toBe(FUND);
    const dustPayment = fundingPayment(
      d(batch.dustLeg!.rate),
      d(batch.dustLeg!.mark),
      d(batch.dustLeg!.qty),
    );
    // 유저 지급은 floor라 합 ≤ 0 — 잔여는 기금이 수령(유저에게 유리한 방향 금지)
    expect(dustPayment.toFixed()).toBe('0.00000001');

    const total = batch.legs.reduce(
      (s, leg) => s.add(fundingPayment(d(leg.rate), d(leg.mark), d(leg.qty))),
      dustPayment,
    );
    expect(total.toFixed()).toBe('0');
  });

  it('라운딩 잔여 없으면 dust leg 없음', () => {
    const batch = buildFundingBatch(
      SYM,
      d('0.0001'),
      d(50000),
      [
        { userId: 'A', qty: d(1) },
        { userId: 'B', qty: d(-1) },
      ],
      FUND,
    );
    expect(batch.dustLeg).toBeNull();
    const payments = batch.legs.map((leg) =>
      fundingPayment(d(leg.rate), d(leg.mark), d(leg.qty)).toFixed(),
    );
    expect(payments).toEqual(['-5', '5']); // 롱 지불 / 숏 수령
  });
});

describe('FundingScheduler.settle', () => {
  afterEach(() => jest.restoreAllMocks());

  it('FundingRate insert + 유저별 FUNDING event + dust event를 한 배치로 append', async () => {
    const db = new FakeDb();
    db.positionRows = [
      { userId: 'A', qty: d('0.003') },
      { userId: 'B', qty: d('-0.001') },
      { userId: 'C', qty: d('-0.002') },
    ];
    const { scheduler } = makeScheduler(db, { mark: d('33333.33333333') });

    await scheduler.settle();

    expect(db.rates).toHaveLength(1);
    expect(db.rates[0].rate.toFixed()).toBe('0.0001'); // 샘플 0개 → 이자율
    expect(db.rates[0].markPrice.toFixed()).toBe('33333.33333333');

    const ts = db.rates[0].fundingTime.toISOString();
    expect(db.events.map((e) => e.sourceKey)).toEqual([
      `funding:${SYM}:${ts}:A`,
      `funding:${SYM}:${ts}:B`,
      `funding:${SYM}:${ts}:C`,
      `funding:${SYM}:${ts}:dust`,
    ]);
    expect(db.events.every((e) => e.kind === 'FUNDING')).toBe(true);
    expect(db.events[3].legs[0].userId).toBe(FUND);
  });

  it('포지션 없으면 FundingRate만 기록', async () => {
    const db = new FakeDb();
    const { scheduler } = makeScheduler(db);

    await scheduler.settle();

    expect(db.rates).toHaveLength(1);
    expect(db.events).toHaveLength(0);
  });

  it('일시 실패 시 같은 fundingTime·드레인한 샘플 그대로 재시도 — 라운드 누락/샘플 유실 없음', async () => {
    jest.useFakeTimers();
    try {
      const db = new FakeDb();
      db.failRateCreates = 1; // 첫 시도만 transient 실패
      db.positionRows = [
        { userId: 'A', qty: d(1) },
        { userId: 'B', qty: d(-1) },
      ];
      const { scheduler, markPrice } = makeScheduler(db, { samples: [d('0.001')] });

      const settled = scheduler.settle();
      await jest.advanceTimersByTimeAsync(10_000);
      await settled;

      expect(db.rates).toHaveLength(1);
      // 보관한 샘플로 계산 — 샘플이 유실됐다면 빈 윈도우 rate 0.0001이 나온다
      expect(db.rates[0].rate.toFixed()).toBe('0.0005');
      expect(markPrice.drainPremiumSamples).toHaveBeenCalledTimes(1);
      expect(db.events).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('멱등: 같은 fundingTime 재실행 시 P2002 swallow — 중복 부과 없음', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1764806400000); // 고정 → 같은 fundingTime
    const db = new FakeDb();
    db.positionRows = [
      { userId: 'A', qty: d(1) },
      { userId: 'B', qty: d(-1) },
    ];
    const { scheduler, markPrice } = makeScheduler(db);

    await scheduler.settle();
    expect(db.rates).toHaveLength(1);
    expect(db.events).toHaveLength(2);

    await scheduler.settle(); // 재실행
    expect(db.rates).toHaveLength(1);
    expect(db.events).toHaveLength(2);
    expect(markPrice.drainPremiumSamples).toHaveBeenCalledTimes(2);
  });
});
