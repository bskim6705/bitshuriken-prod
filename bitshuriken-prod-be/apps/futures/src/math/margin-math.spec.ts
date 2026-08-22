import { OrderSide } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { ceil8, floor8 } from '@app/shared/decimal';
import {
  assumingPrice,
  bankruptcyPrice,
  crossAccountEquity,
  crossAccountMarginRatio,
  crossEffectiveMargin,
  initialMargin,
  isCrossAccountLiquidationTarget,
  liquidationPrice,
  maintenanceMargin,
  marginRatio,
  notional,
  openLoss,
  orderCost,
  priceBandCheck,
  type CrossLeg,
  unrealizedPnl,
} from './margin-math';

const d = (v: string | number) => new Decimal(v);

describe('rounding helpers', () => {
  it('floor8은 -∞ 방향 (음수 절대값 증가 = 차감 ceil)', () => {
    expect(floor8(d('1.234567891')).toFixed()).toBe('1.23456789');
    expect(floor8(d('-1.234567891')).toFixed()).toBe('-1.2345679');
  });

  it('ceil8은 +∞ 방향', () => {
    expect(ceil8(d('1.234567891')).toFixed()).toBe('1.2345679');
    expect(ceil8(d('-1.234567891')).toFixed()).toBe('-1.23456789');
  });
});

describe('assumingPrice (MARKET 가정가)', () => {
  it('BUY: m×(1+buffer) — 50000 × 1.005 = 50250', () => {
    expect(assumingPrice(d(50000), OrderSide.BUY, d('0.005')).toFixed()).toBe('50250');
  });

  it('SELL: m×(1−buffer) — 50000 × 0.995 = 49750', () => {
    expect(assumingPrice(d(50000), OrderSide.SELL, d('0.005')).toFixed()).toBe('49750');
  });

  it('라운딩은 mark에서 먼 쪽 (BUY ceil / SELL floor) — 보수적 잠금', () => {
    // 100.00000001 × 1.005 = 100.5000000100005 → ceil8 = 100.50000002
    expect(assumingPrice(d('100.00000001'), OrderSide.BUY, d('0.005')).toFixed()).toBe(
      '100.50000002',
    );
    // 100.00000001 × 0.995 = 99.5000000099995 → floor8 = 99.5
    expect(assumingPrice(d('100.00000001'), OrderSide.SELL, d('0.005')).toFixed()).toBe('99.5');
  });
});

describe('notional / initialMargin / openLoss', () => {
  it('notional = p × |qty| (signed qty 허용)', () => {
    expect(notional(d(50000), d('0.5')).toFixed()).toBe('25000');
    expect(notional(d(50000), d('-0.5')).toFixed()).toBe('25000');
  });

  it('IM = notional/lev, 차감 방향 ceil — 100/3 = 33.33333334', () => {
    expect(initialMargin(d(25000), 10).toFixed()).toBe('2500');
    expect(initialMargin(d(100), 3).toFixed()).toBe('33.33333334');
  });

  it('openLoss BUY = max(0, p−m)×q', () => {
    expect(openLoss(OrderSide.BUY, d(50100), d(50000), d(2)).toFixed()).toBe('200');
    expect(openLoss(OrderSide.BUY, d(49900), d(50000), d(2)).toFixed()).toBe('0');
  });

  it('openLoss SELL = max(0, m−p)×q', () => {
    expect(openLoss(OrderSide.SELL, d(49900), d(50000), d(2)).toFixed()).toBe('200');
    expect(openLoss(OrderSide.SELL, d(50100), d(50000), d(2)).toFixed()).toBe('0');
  });

  it('openLoss 차감 방향 ceil — 1e-8 × 0.3 = 3e-9 → 0.00000001', () => {
    expect(openLoss(OrderSide.BUY, d('50000.00000001'), d(50000), d('0.3')).toFixed()).toBe(
      '0.00000001',
    );
  });
});

describe('orderCost = IM + openLoss + 수수료 예약', () => {
  it('LIMIT BUY @ mark: 5000/10 + 0 + 5000×5bps = 502.5', () => {
    const cost = orderCost({
      side: OrderSide.BUY,
      price: d(50000),
      mark: d(50000),
      qty: d('0.1'),
      leverage: 10,
      takerFeeBps: 5,
    });
    expect(cost.toFixed()).toBe('502.5');
  });

  it('MARKET BUY 가정가: ap=50250 → 502.5 + 25 + 2.5125 = 530.0125', () => {
    const ap = assumingPrice(d(50000), OrderSide.BUY, d('0.005'));
    const cost = orderCost({
      side: OrderSide.BUY,
      price: ap,
      mark: d(50000),
      qty: d('0.1'),
      leverage: 10,
      takerFeeBps: 5,
    });
    expect(cost.toFixed()).toBe('530.0125');
  });

  it('MARKET SELL 가정가: ap=49750 → 1492.5 + 75 + 7.4625 = 1574.9625', () => {
    const ap = assumingPrice(d(50000), OrderSide.SELL, d('0.005'));
    const cost = orderCost({
      side: OrderSide.SELL,
      price: ap,
      mark: d(50000),
      qty: d('0.3'),
      leverage: 10,
      takerFeeBps: 5,
    });
    expect(cost.toFixed()).toBe('1574.9625');
  });
});

describe('priceBandCheck', () => {
  it('경계 포함 [m×(1−band), m×(1+band)]', () => {
    const m = d(50000);
    const band = d('0.05');
    expect(priceBandCheck(d(47500), m, band)).toBe(true);
    expect(priceBandCheck(d(52500), m, band)).toBe(true);
    expect(priceBandCheck(d('47499.99999999'), m, band)).toBe(false);
    expect(priceBandCheck(d('52500.00000001'), m, band)).toBe(false);
  });
});

describe('liquidationPrice / bankruptcyPrice', () => {
  // 손계산: 롱 LP = (EP×Q − margin)/(Q×(1−mmr)) = (50000−5000)/0.995
  //        = 45226.13065326633... → ceil8(유저에게 가깝게) = 45226.13065327
  it('롱 LP: 45000/0.995 → ceil8 = 45226.13065327', () => {
    expect(liquidationPrice(d(50000), d(1), d(5000), d('0.005')).toFixed()).toBe('45226.13065327');
  });

  // 손계산: 숏 LP = (EP×Q + margin)/(Q×(1+mmr)) = 55000/1.005
  //        = 54726.36815920398... → floor8 = 54726.3681592
  it('숏 LP: 55000/1.005 → floor8 = 54726.3681592', () => {
    expect(liquidationPrice(d(50000), d(-1), d(5000), d('0.005')).toFixed()).toBe('54726.3681592');
  });

  it('LP에서 marginRatio == 1 (공식 일관성)', () => {
    const lp = liquidationPrice(d(50000), d(1), d(5000), d('0.005'));
    const mm = maintenanceMargin(d('0.005'), lp, d(1));
    const upnl = unrealizedPnl(lp, d(50000), d(1));
    const ratio = marginRatio(mm, d(5000), upnl);
    expect(ratio).not.toBeNull();
    expect(ratio!.gte(1)).toBe(true);
  });

  it('qty == 0이면 throw', () => {
    expect(() => liquidationPrice(d(50000), d(0), d(5000), d('0.005'))).toThrow();
    expect(() => bankruptcyPrice(d(50000), d(0), d(5000))).toThrow();
  });

  // 손계산: 롱 BP = EP − margin/Q = 50000 − 5000/1 = 45000
  it('롱 BP: 50000 − 5000 = 45000', () => {
    expect(bankruptcyPrice(d(50000), d(1), d(5000)).toFixed()).toBe('45000');
  });

  it('BP 라운딩은 EP에서 먼 쪽 (롱 floor / 숏 ceil)', () => {
    // 1000/3 = 333.333... → 롱: 50000 − 333.333... → floor8 = 49666.66666666
    expect(bankruptcyPrice(d(50000), d(3), d(1000)).toFixed()).toBe('49666.66666666');
    // 숏: 50000 + 333.333... → ceil8 = 50333.33333334
    expect(bankruptcyPrice(d(50000), d(-3), d(1000)).toFixed()).toBe('50333.33333334');
  });
});

describe('unrealizedPnl / maintenanceMargin / marginRatio', () => {
  it('UPNL = (m − EP) × qty — signed로 롱/숏 모두 성립', () => {
    expect(unrealizedPnl(d(51000), d(50000), d('0.5')).toFixed()).toBe('500');
    expect(unrealizedPnl(d(51000), d(50000), d('-0.5')).toFixed()).toBe('-500');
  });

  it('UPNL 라운딩: 지급 floor / 차감 ceil (signed floor)', () => {
    expect(unrealizedPnl(d('50000.00000001'), d(50000), d('0.3')).toFixed()).toBe('0');
    expect(unrealizedPnl(d('50000.00000001'), d(50000), d('-0.3')).toFixed()).toBe('-0.00000001');
  });

  it('MM = mmr×m×Q, ceil', () => {
    expect(maintenanceMargin(d('0.005'), d(50000), d(1)).toFixed()).toBe('250');
    // 0.005 × 33333.33333333 × 0.1 = 16.666666666665 → ceil8 = 16.66666667
    expect(maintenanceMargin(d('0.005'), d('33333.33333333'), d('0.1')).toFixed()).toBe(
      '16.66666667',
    );
  });

  it('marginRatio = MM/(margin+UPNL)', () => {
    expect(marginRatio(d(250), d(5000), d(-1000))!.toFixed()).toBe('0.0625');
    expect(marginRatio(d(250), d(200), d(30))!.gte(1)).toBe(true);
  });

  it('분모 ≤ 0이면 null (즉시 청산 대상)', () => {
    expect(marginRatio(d(250), d(500), d(-500))).toBeNull();
    expect(marginRatio(d(250), d(500), d(-600))).toBeNull();
  });
});

describe('cross 마진 (계정 단위)', () => {
  const leg = (over: Partial<CrossLeg> = {}): CrossLeg => ({
    isolatedMargin: d(1000),
    upnl: d(0),
    mm: d(50),
    ...over,
  });

  it('crossEquity = freeBalance + Σ(margin + UPNL) — 이익/손실 상계', () => {
    const legs = [leg({ upnl: d(-400) }), leg({ isolatedMargin: d(500), upnl: d(300) })];
    // 200 + (1000−400) + (500+300) = 1600
    expect(crossAccountEquity(d(200), legs).toFixed()).toBe('1600');
  });

  it('한 포지션의 이익이 다른 포지션의 손실을 가려 계정이 건전', () => {
    // 손실 −900짜리와 이익 +900짜리: equity = 0 + (1000−900)+(1000+900) = 2000, MM 100 → 비대상
    const legs = [leg({ upnl: d(-900), mm: d(50) }), leg({ upnl: d(900), mm: d(50) })];
    expect(isCrossAccountLiquidationTarget(d(0), legs)).toBe(false);
  });

  it('계정 합산 손실이 깊어지면 ratio ≥ 1 → 대상', () => {
    // equity = 0 + (1000−980)+(1000−980) = 40, MM = 25+25 = 50 → ratio 1.25 ≥ 1
    const legs = [leg({ upnl: d(-980), mm: d(25) }), leg({ upnl: d(-980), mm: d(25) })];
    expect(crossAccountMarginRatio(d(0), legs)!.gte(1)).toBe(true);
    expect(isCrossAccountLiquidationTarget(d(0), legs)).toBe(true);
  });

  it('equity ≤ 0이면 즉시 대상, ratio는 null', () => {
    const legs = [leg({ isolatedMargin: d(100), upnl: d(-100) })];
    expect(crossAccountMarginRatio(d(0), legs)).toBeNull();
    expect(isCrossAccountLiquidationTarget(d(0), legs)).toBe(true);
  });

  it('free 잔고가 손실을 흡수해 계정 건전 유지', () => {
    const legs = [leg({ upnl: d(-980), mm: d(25) }), leg({ upnl: d(-980), mm: d(25) })];
    // freeBalance 10000 추가 → equity 10040 ≫ MM 50 → 비대상
    expect(isCrossAccountLiquidationTarget(d(10000), legs)).toBe(false);
  });

  it('leg 0개면 비대상/null', () => {
    expect(isCrossAccountLiquidationTarget(d(100), [])).toBe(false);
    expect(crossAccountMarginRatio(d(100), [])).toBeNull();
  });

  it('crossEffectiveMargin: 단일 cross는 free 잔고만큼 isolated보다 마진이 크다', () => {
    // others 없음 → effective = selfMargin + freeBalance
    expect(crossEffectiveMargin(d(500), d(1000), []).toFixed()).toBe('1500');
    // 타 포지션의 여유(margin+upnl−mm)가 더해진다: free 0 + (2000+100−50) = 2050 + self 1000
    const others = [leg({ isolatedMargin: d(2000), upnl: d(100), mm: d(50) })];
    expect(crossEffectiveMargin(d(0), d(1000), others).toFixed()).toBe('3050');
  });
});
