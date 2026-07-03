import { FuturesIncomeType, OrderSide } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { orderCost } from './margin-math';
import {
  applyFill,
  applyFundingPayment,
  Fill,
  fundingPayment,
  lockedReleaseForFill,
  PositionState,
  refundAmount,
} from './position-math';

const d = (v: string | number) => new Decimal(v);

const flat = (leverage = 10): PositionState => ({
  qty: d(0),
  entryPrice: d(0),
  isolatedMargin: d(0),
  leverage,
});

const pos = (
  qty: string | number,
  ep: string | number,
  margin: string | number,
  leverage = 10,
) => ({
  qty: d(qty),
  entryPrice: d(ep),
  isolatedMargin: d(margin),
  leverage,
});

const fill = (over: Partial<Fill>): Fill => ({
  price: d(50000),
  qty: d(1),
  side: OrderSide.BUY,
  feeBps: 5,
  lockedCost: d(0),
  origQty: d(1),
  prevExecutedQty: d(0),
  reduceOnly: false,
  liquidation: false,
  ...over,
});

const ctx = (balance: string | number = 0) => ({ balance: d(balance) });

const incomeOf = (
  result: { incomeRecords: { incomeType: FuturesIncomeType; income: Decimal }[] },
  type: FuturesIncomeType,
) => result.incomeRecords.find((r) => r.incomeType === type)?.income;

describe('lockedReleaseForFill (누적식 비례 해제)', () => {
  it('정확히 나누어지면 floor(lockedCost×q/origQty)와 동일', () => {
    // 1590.0375 × 0.1 / 0.3 = 530.0125
    expect(lockedReleaseForFill(d('1590.0375'), d('0.3'), d(0), d('0.1')).toFixed()).toBe(
      '530.0125',
    );
  });

  it('나누어지지 않아도 전량 체결 시 합 == lockedCost (telescoping)', () => {
    // 100 × 0.1/0.3 = 33.333... — 단순 floor 합산이면 99.99999999로 dust lock
    const r1 = lockedReleaseForFill(d(100), d('0.3'), d(0), d('0.1'));
    const r2 = lockedReleaseForFill(d(100), d('0.3'), d('0.1'), d('0.1'));
    const r3 = lockedReleaseForFill(d(100), d('0.3'), d('0.2'), d('0.1'));
    expect(r1.toFixed()).toBe('33.33333333');
    expect(r2.toFixed()).toBe('33.33333333');
    expect(r3.toFixed()).toBe('33.33333334');
    expect(r1.add(r2).add(r3).toFixed()).toBe('100');
  });

  it('보존 법칙: Σ release + refund == lockedCost (불균등/극소값 포함)', () => {
    const cases: [Decimal, Decimal, Decimal[]][] = [
      [d('1507.5'), d('0.3'), [d('0.07'), d('0.13'), d('0.1')]],
      [d('0.00000007'), d(3), [d(1), d(1), d(1)]],
      [d(100), d('0.3'), [d('0.1')]], // 부분 체결 후 취소
    ];
    for (const [lockedCost, origQty, fills] of cases) {
      let cum = d(0);
      let released = d(0);
      for (const q of fills) {
        released = released.add(lockedReleaseForFill(lockedCost, origQty, cum, q));
        cum = cum.add(q);
      }
      const refund = refundAmount(lockedCost, origQty, cum);
      expect(released.add(refund).toFixed()).toBe(lockedCost.toFixed());
    }
  });

  it('lockedCost 0이면 0 (reduceOnly/liquidation 주문)', () => {
    expect(lockedReleaseForFill(d(0), d(1), d(0), d(1)).isZero()).toBe(true);
  });

  it('체결 누적이 origQty를 넘으면 throw', () => {
    expect(() => lockedReleaseForFill(d(100), d(1), d('0.9'), d('0.2'))).toThrow();
  });
});

describe('refundAmount', () => {
  it('refund = lockedCost − 총해제분. 정확히 나누어지면 floor(L×(X−eq)/X)와 동일', () => {
    // 1590.0375 − floor(1590.0375×0.1/0.3) = 1590.0375 − 530.0125 = 1060.025
    expect(refundAmount(d('1590.0375'), d('0.3'), d('0.1')).toFixed()).toBe('1060.025');
  });

  it('미체결 전량 취소 → 전액, 전량 체결 → 0', () => {
    expect(refundAmount(d('1590.0375'), d('0.3'), d(0)).toFixed()).toBe('1590.0375');
    expect(refundAmount(d('1590.0375'), d('0.3'), d('0.3')).toFixed()).toBe('0');
  });

  it('eq > origQty면 throw', () => {
    expect(() => refundAmount(d(100), d(1), d('1.1'))).toThrow();
  });
});

describe('applyFill — 증량', () => {
  // MARKET BUY origQty 3, lockedCost = orderCost(ap=50250, q=3) = 15075 + 750 + 75.375
  const lockedCost = d('15900.375');

  it('multi-fill EP 가중평균: 3연속 fill == 한 번에 계산', () => {
    let p = flat();
    const prices = [d(50000), d(51000), d(52000)];
    let cum = d(0);
    for (const price of prices) {
      const r = applyFill(
        p,
        fill({ price, qty: d(1), origQty: d(3), lockedCost, prevExecutedQty: cum }),
        ctx(0),
      );
      p = r.newPosition;
      cum = cum.add(1);
    }
    // 한 번에: (50000 + 51000 + 52000)/3 = 51000
    expect(p.qty.toFixed()).toBe('3');
    expect(p.entryPrice.toFixed()).toBe('51000');
    // marginAdd 합: 5000 + 5100 + 5200
    expect(p.isolatedMargin.toFixed()).toBe('15300');
  });

  it('EP 가중평균은 floor 8dp', () => {
    let p = flat();
    p = applyFill(p, fill({ price: d(50000), qty: d(1) }), ctx()).newPosition;
    // (1×50000 + 2×50001)/3 = 50000.66666666...→ floor8
    p = applyFill(p, fill({ price: d(50001), qty: d(2), origQty: d(2) }), ctx()).newPosition;
    expect(p.entryPrice.toFixed()).toBe('50000.66666666');
  });

  it('wallet 이동: lockedRelease 환급 − marginAdd − fee', () => {
    const r = applyFill(
      flat(),
      fill({ price: d(50000), qty: d(1), origQty: d(3), lockedCost, prevExecutedQty: d(0) }),
      ctx(0),
    );
    // lockedRelease 5300.125, marginAdd 5000, fee ceil(50000×5/10000) = 25
    expect(r.walletDeltas.lockedDelta.toFixed()).toBe('-5300.125');
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('275.125');
    expect(incomeOf(r, FuturesIncomeType.COMMISSION)!.toFixed()).toBe('-25');
    expect(incomeOf(r, FuturesIncomeType.REALIZED_PNL)).toBeUndefined();
    expect(r.shortfalls).toHaveLength(0);
    expect(r.fundTakeover).toBeNull();
  });

  it('수수료 ceil / marginAdd ceil', () => {
    const r = applyFill(
      flat(),
      fill({ price: d('33333.33333333'), qty: d('0.1'), feeBps: 7, origQty: d('0.1') }),
      ctx(0),
    );
    // fee = 3333.3333333330 × 7/10000 = 2.3333333333331 → ceil8 = 2.33333334
    expect(incomeOf(r, FuturesIncomeType.COMMISSION)!.toFixed()).toBe('-2.33333334');
    // marginAdd = 3333.333333333/10 = 333.3333333333 → ceil8 = 333.33333334
    expect(r.newPosition.isolatedMargin.toFixed()).toBe('333.33333334');
  });

  it('숏 증량 대칭: SELL fill은 음수 qty 누적 + 동일 EP 가중평균', () => {
    let p = flat();
    p = applyFill(p, fill({ side: OrderSide.SELL, price: d(50000), qty: d(1) }), ctx()).newPosition;
    p = applyFill(p, fill({ side: OrderSide.SELL, price: d(52000), qty: d(1) }), ctx()).newPosition;
    expect(p.qty.toFixed()).toBe('-2');
    expect(p.entryPrice.toFixed()).toBe('51000');
  });

  it('체결가가 가정가보다 불리해 lockedRelease로 부족하면 shortfall 기록', () => {
    // lockedCost는 가정가 50250 기준 5277.51인데 60000에 체결
    const r = applyFill(
      flat(),
      fill({ price: d(60000), qty: d(1), lockedCost: d('5277.51'), origQty: d(1) }),
      ctx(700),
    );
    // balanceDelta = 5277.51 − 6000 − 30 = −752.49, balance 700 → −52.49
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('-752.49');
    expect(r.shortfalls).toHaveLength(1);
    expect(r.shortfalls[0].amount.toFixed()).toBe('52.49');
  });
});

describe('applyFill — 감량', () => {
  it('부분 close: RPNL + 마진 비례 해제 + reduceOnly 무잠금', () => {
    const r = applyFill(
      pos(3, 50000, 15000),
      fill({ side: OrderSide.SELL, price: d(51000), qty: d(1), reduceOnly: true }),
      ctx(0),
    );
    // RPNL = (51000−50000)×1×(+1) = 1000, marginRelease = floor(15000×1/3) = 5000, fee 25.5
    expect(r.newPosition.qty.toFixed()).toBe('2');
    expect(r.newPosition.entryPrice.toFixed()).toBe('50000');
    expect(r.newPosition.isolatedMargin.toFixed()).toBe('10000');
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('5974.5');
    expect(r.walletDeltas.lockedDelta.toFixed()).toBe('0');
    expect(incomeOf(r, FuturesIncomeType.REALIZED_PNL)!.toFixed()).toBe('1000');
    expect(incomeOf(r, FuturesIncomeType.COMMISSION)!.toFixed()).toBe('-25.5');
  });

  it('marginRelease는 floor — 순차 부분 close 후에도 전량 close면 margin 정확히 0', () => {
    let p = pos(3, 50000, 100);
    const close = (q: number) =>
      applyFill(p, fill({ side: OrderSide.SELL, qty: d(q), feeBps: 0, reduceOnly: true }), ctx());
    let r = close(1); // floor(100/3) = 33.33333333
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('33.33333333');
    p = r.newPosition;
    r = close(1); // floor(66.66666667/2) = 33.33333333
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('33.33333333');
    p = r.newPosition;
    r = close(1); // 전량: 잔여 33.33333334 전부
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('33.33333334');
    expect(r.newPosition.qty.toFixed()).toBe('0');
    expect(r.newPosition.entryPrice.toFixed()).toBe('0');
    expect(r.newPosition.isolatedMargin.toFixed()).toBe('0');
  });

  it('숏 감량 대칭: RPNL = (p−EP)×c×sign(qty)', () => {
    const r = applyFill(
      pos(-2, 51000, 10200),
      fill({ side: OrderSide.BUY, price: d(49000), qty: d('0.5'), reduceOnly: true }),
      ctx(0),
    );
    // RPNL = (49000−51000)×0.5×(−1) = 1000, marginRelease = floor(10200×0.5/2) = 2550, fee 12.25
    expect(r.newPosition.qty.toFixed()).toBe('-1.5');
    expect(r.newPosition.isolatedMargin.toFixed()).toBe('7650');
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('3537.75');
    expect(incomeOf(r, FuturesIncomeType.REALIZED_PNL)!.toFixed()).toBe('1000');
  });

  it('RPNL 라운딩: 지급 floor / 차감 ceil (signed floor)', () => {
    const dust = applyFill(
      pos('0.3', 50000, 1500),
      fill({
        side: OrderSide.SELL,
        price: d('50000.00000001'),
        qty: d('0.3'),
        feeBps: 0,
        reduceOnly: true,
      }),
      ctx(0),
    );
    expect(incomeOf(dust, FuturesIncomeType.REALIZED_PNL)!.toFixed()).toBe('0');

    const dustShort = applyFill(
      pos('-0.3', 50000, 1500),
      fill({
        side: OrderSide.BUY,
        price: d('50000.00000001'),
        qty: d('0.3'),
        feeBps: 0,
        reduceOnly: true,
      }),
      ctx(0),
    );
    expect(incomeOf(dustShort, FuturesIncomeType.REALIZED_PNL)!.toFixed()).toBe('-0.00000001');
  });

  it('liquidation 주문: liqFee 추가 차감 + 보험기금 적립 + shortfall 기록', () => {
    const r = applyFill(
      pos(1, 50000, 5000),
      fill({
        side: OrderSide.SELL,
        price: d(45000),
        qty: d(1),
        liquidation: true,
        liquidationFeeRate: d('0.005'),
      }),
      ctx(0),
    );
    // RPNL −5000, marginRelease 5000, fee 22.5, liqFee = ceil(45000×0.005) = 225
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('-247.5');
    expect(r.fundTransfers).toHaveLength(1);
    expect(r.fundTransfers[0].reason).toBe('LIQUIDATION_FEE');
    expect(r.fundTransfers[0].amount.toFixed()).toBe('225');
    expect(incomeOf(r, FuturesIncomeType.REALIZED_PNL)!.toFixed()).toBe('-5000');
    expect(incomeOf(r, FuturesIncomeType.LIQUIDATION_FEE)!.toFixed()).toBe('-225');
    // balance 0에서 −247.5 → 음수 진입은 허용하되 shortfall로 보고 (fail loudly)
    expect(r.shortfalls).toHaveLength(1);
    expect(r.shortfalls[0].amount.toFixed()).toBe('247.5');
    expect(r.newPosition.qty.toFixed()).toBe('0');
  });
});

describe('applyFill — 왕복 보존 법칙', () => {
  it('open→전량 close 후 locked 소진, 잔여 = 수수료만 차감된 balance', () => {
    // MARKET BUY 0.3: lockedCost = orderCost(ap 50250) = 1507.5 + 75 + 7.5375
    const openCost = orderCost({
      side: OrderSide.BUY,
      price: d(50250),
      mark: d(50000),
      qty: d('0.3'),
      leverage: 10,
      takerFeeBps: 5,
    });
    expect(openCost.toFixed()).toBe('1590.0375');

    let balance = d(10000);
    let locked = d(0);
    // 접수단 잠금: balance → locked
    balance = balance.sub(openCost);
    locked = locked.add(openCost);

    let p = flat();
    let cum = d(0);
    let releasedSum = d(0);
    for (let i = 0; i < 3; i++) {
      const r = applyFill(
        p,
        fill({
          price: d(50000),
          qty: d('0.1'),
          origQty: d('0.3'),
          lockedCost: openCost,
          prevExecutedQty: cum,
        }),
        { balance },
      );
      p = r.newPosition;
      balance = balance.add(r.walletDeltas.balanceDelta);
      locked = locked.add(r.walletDeltas.lockedDelta);
      releasedSum = releasedSum.add(r.walletDeltas.lockedDelta.neg());
      cum = cum.add('0.1');
      expect(r.shortfalls).toHaveLength(0);
    }
    expect(p.qty.toFixed()).toBe('0.3');
    expect(p.entryPrice.toFixed()).toBe('50000');
    expect(p.isolatedMargin.toFixed()).toBe('1500');
    // 보존: Σ lockedRelease + refund == lockedCost (전량 체결이라 refund 0)
    expect(releasedSum.add(refundAmount(openCost, d('0.3'), cum)).toFixed()).toBe(
      openCost.toFixed(),
    );
    expect(locked.toFixed()).toBe('0');

    // 전량 close: 일반 MARKET SELL 0.3 (reduceOnly 아님 — lockedCost 잠금)
    const closeCost = orderCost({
      side: OrderSide.SELL,
      price: d(49750),
      mark: d(50000),
      qty: d('0.3'),
      leverage: 10,
      takerFeeBps: 5,
    });
    expect(closeCost.toFixed()).toBe('1574.9625');
    balance = balance.sub(closeCost);
    locked = locked.add(closeCost);

    const r = applyFill(
      p,
      fill({
        side: OrderSide.SELL,
        price: d(50000),
        qty: d('0.3'),
        origQty: d('0.3'),
        lockedCost: closeCost,
        prevExecutedQty: d(0),
      }),
      { balance },
    );
    balance = balance.add(r.walletDeltas.balanceDelta);
    locked = locked.add(r.walletDeltas.lockedDelta);

    // 왕복 후: 포지션/락 잔여 0, balance = 10000 − 수수료(7.5 + 7.5)
    expect(r.newPosition.qty.toFixed()).toBe('0');
    expect(r.newPosition.entryPrice.toFixed()).toBe('0');
    expect(r.newPosition.isolatedMargin.toFixed()).toBe('0');
    expect(locked.toFixed()).toBe('0');
    expect(balance.toFixed()).toBe('9985');
  });
});

describe('applyFill — flip', () => {
  it('일반 주문 flip: close-then-open, 초과분 EP=p, IM은 lockedRelease에서', () => {
    // 롱 1 → SELL 2 @ 50000. SELL 주문 lockedCost = 10000 + 0 + 50 = 10050
    const r = applyFill(
      pos(1, 50000, 5000),
      fill({
        side: OrderSide.SELL,
        price: d(50000),
        qty: d(2),
        origQty: d(2),
        lockedCost: d(10050),
      }),
      ctx(0),
    );
    // close: RPNL 0, marginRelease 5000, feeClose 25 / open: feeOpen 25, newIM 5000
    // lockedRelease 10050 → IM 5000 충당, 잔여 5050 환급
    expect(r.newPosition.qty.toFixed()).toBe('-1');
    expect(r.newPosition.entryPrice.toFixed()).toBe('50000');
    expect(r.newPosition.isolatedMargin.toFixed()).toBe('5000');
    expect(r.walletDeltas.lockedDelta.toFixed()).toBe('-10050');
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('10000');
    expect(incomeOf(r, FuturesIncomeType.REALIZED_PNL)!.toFixed()).toBe('0');
    expect(incomeOf(r, FuturesIncomeType.COMMISSION)!.toFixed()).toBe('-50');
    expect(r.fundTakeover).toBeNull();
    expect(r.shortfalls).toHaveLength(0);
  });

  it('reduceOnly flip(레이스 잔존분): 무잠금 — IM 부족분은 balance에서', () => {
    const r = applyFill(
      pos(1, 50000, 5000),
      fill({ side: OrderSide.SELL, price: d(50000), qty: d(2), origQty: d(2), reduceOnly: true }),
      ctx(6000),
    );
    // lockedRelease 0 → newIM 5000 전액 balance: 5000 − 50 − 5000 = −50
    expect(r.newPosition.qty.toFixed()).toBe('-1');
    expect(r.newPosition.isolatedMargin.toFixed()).toBe('5000');
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('-50');
    expect(r.fundTakeover).toBeNull();
    expect(r.shortfalls).toHaveLength(0);
  });

  it('shortage 0이면 balance가 음수가 돼도 정상 flip — 기금 인수 아님', () => {
    const r = applyFill(
      pos(1, 50000, 5000),
      fill({
        side: OrderSide.SELL,
        price: d(40000),
        qty: d(2),
        origQty: d(2),
        lockedCost: d(4000),
        feeBps: 0,
      }),
      ctx(2000),
    );
    // close: RPNL −10000 + marginRelease 5000 → −5000. newIM 4000은 fromLocked 전액 → shortage 0
    // balanceBeforeIM = 2000 − 5000 = −3000이지만 부족분이 0이라 인수 사유 없음
    expect(r.fundTakeover).toBeNull();
    expect(r.newPosition.qty.toFixed()).toBe('-1');
    expect(r.newPosition.entryPrice.toFixed()).toBe('40000');
    expect(r.newPosition.isolatedMargin.toFixed()).toBe('4000');
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('-5000');
    expect(r.walletDeltas.lockedDelta.toFixed()).toBe('-4000');
    // 잔고 음수 진입은 shortfall 보고로만 (fail loudly)
    expect(r.shortfalls).toHaveLength(1);
    expect(r.shortfalls[0].reason).toBe('BALANCE_NEGATIVE_AFTER_FILL');
  });

  it('flip 수수료는 전체 q 단일 ceil — close/open 분할 ceil로 1e-8 과차감하지 않는다', () => {
    const r = applyFill(
      pos('0.00000001', 100, '0.000001', 1),
      fill({
        side: OrderSide.SELL,
        price: d(100),
        qty: d('0.00000002'),
        origQty: d('0.00000002'),
        lockedCost: d('0.000001'),
        feeBps: 1,
      }),
      ctx(1),
    );
    // fee = ceil8(100×0.00000002×1bps) = 0.00000001 — 분할 ceil이면 0.00000002 (Trade.commission과 어긋남)
    expect(incomeOf(r, FuturesIncomeType.COMMISSION)!.toFixed()).toBe('-0.00000001');
    // marginRelease 0.000001 + RPNL 0 − fee, shortage 0
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('0.00000099');
    expect(r.newPosition.qty.toFixed()).toBe('-0.00000001');
  });

  it('잔고 부족 flip: 신규분 보험기금 인수(fundTakeover) + shortfall', () => {
    // lockedCost 1000 — MARKET이 가정가보다 크게 불리하게 체결된 상황
    const r = applyFill(
      pos(1, 50000, 5000),
      fill({
        side: OrderSide.SELL,
        price: d(50000),
        qty: d(2),
        origQty: d(2),
        lockedCost: d(1000),
      }),
      ctx(-2000),
    );
    // fromLocked 1000, shortage 4000, balanceBeforeIM = −2000+5000−50 = 2950 < 4000 → 인수
    expect(r.newPosition.qty.toFixed()).toBe('0');
    expect(r.newPosition.isolatedMargin.toFixed()).toBe('0');
    expect(r.fundTakeover).not.toBeNull();
    expect(r.fundTakeover!.qty.toFixed()).toBe('-1');
    expect(r.fundTakeover!.entryPrice.toFixed()).toBe('50000');
    expect(r.fundTakeover!.margin.toFixed()).toBe('1000');
    // 유저 balance: marginRelease 5000 − fees 50 (fromLocked는 기금으로)
    expect(r.walletDeltas.balanceDelta.toFixed()).toBe('4950');
    expect(r.walletDeltas.lockedDelta.toFixed()).toBe('-1000');
    expect(r.shortfalls).toHaveLength(1);
    expect(r.shortfalls[0].amount.toFixed()).toBe('1050');
  });
});

describe('applyFill — 입력 검증', () => {
  it('qty/price ≤ 0이면 throw', () => {
    expect(() => applyFill(flat(), fill({ qty: d(0) }), ctx())).toThrow();
    expect(() => applyFill(flat(), fill({ price: d(-1) }), ctx())).toThrow();
  });

  it('liquidation인데 liquidationFeeRate 없으면 throw', () => {
    expect(() =>
      applyFill(pos(1, 50000, 5000), fill({ side: OrderSide.SELL, liquidation: true }), ctx()),
    ).toThrow();
  });
});

describe('funding', () => {
  it('지급액 = −F×m×qty: F>0이면 롱 지불/숏 수령, F<0이면 반대', () => {
    expect(fundingPayment(d('0.0001'), d(50000), d(1)).toFixed()).toBe('-5');
    expect(fundingPayment(d('0.0001'), d(50000), d(-1)).toFixed()).toBe('5');
    expect(fundingPayment(d('-0.0001'), d(50000), d(1)).toFixed()).toBe('5');
  });

  it('zero-sum: 심볼 합 qty 0이면 지급 합도 0 (정확히 나누어지는 케이스)', () => {
    const qtys = [d(1), d('-0.4'), d('-0.6')];
    const sum = qtys
      .map((q) => fundingPayment(d('0.0001'), d(50000), q))
      .reduce((a, b) => a.add(b), d(0));
    expect(sum.toFixed()).toBe('0');
  });

  it('라운딩 dust는 음수(시스템 잉여) — 보험기금 귀속분은 양수', () => {
    const qtys = [d('0.1'), d('0.2'), d('-0.3')];
    const sum = qtys
      .map((q) => fundingPayment(d('0.00037'), d('33333.33333333'), q))
      .reduce((a, b) => a.add(b), d(0));
    // floor(−1.2333...) + floor(−2.4666...) + floor(3.6999...) = −0.00000002
    expect(sum.toFixed()).toBe('-0.00000002');
    expect(sum.lte(0)).toBe(true);
    expect(sum.neg().lt(qtys.length * 1e-8)).toBe(true);
  });

  it('차감 폭포: balance 우선, 부족분 isolatedMargin + 재평가 플래그', () => {
    const partial = applyFundingPayment(d(-100), d(60));
    expect(partial.balanceDelta.toFixed()).toBe('-60');
    expect(partial.marginDelta.toFixed()).toBe('-40');
    expect(partial.reevaluate).toBe(true);

    const fromBalance = applyFundingPayment(d(-100), d(150));
    expect(fromBalance.balanceDelta.toFixed()).toBe('-100');
    expect(fromBalance.marginDelta.toFixed()).toBe('0');
    expect(fromBalance.reevaluate).toBe(false);

    const negativeBalance = applyFundingPayment(d(-100), d(-10));
    expect(negativeBalance.balanceDelta.toFixed()).toBe('0');
    expect(negativeBalance.marginDelta.toFixed()).toBe('-100');
    expect(negativeBalance.reevaluate).toBe(true);
  });

  it('수령(+)은 balance로만', () => {
    const receive = applyFundingPayment(d(50), d(0));
    expect(receive.balanceDelta.toFixed()).toBe('50');
    expect(receive.marginDelta.toFixed()).toBe('0');
    expect(receive.reevaluate).toBe(false);
  });
});
