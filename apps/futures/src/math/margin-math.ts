import { OrderSide } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { ceil8, floor8 } from '@app/shared/decimal';

// 순수 마진 산식 모음 — DB/IO 없음. 전부 Prisma Decimal 8dp.
// 라운딩 원칙: 유저에게 유리한 방향 금지 — 지급 floor, 차감 ceil.

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const BPS_DENOMINATOR = new Decimal(10000);

/** MARKET 가정가: BUY m×(1+buffer)/SELL m×(1−buffer). mark에서 먼 쪽으로 라운딩(보수적 잠금). */
export function assumingPrice(mark: Decimal, side: OrderSide, bufferPct: Decimal): Decimal {
  return side === OrderSide.BUY
    ? ceil8(mark.mul(ONE.add(bufferPct)))
    : floor8(mark.mul(ONE.sub(bufferPct)));
}

/** notional = p × |qty| (USDT). 8dp×8dp 곱은 Decimal에서 정확 — 무라운딩. */
export function notional(price: Decimal, qty: Decimal): Decimal {
  return price.mul(qty.abs());
}

/** IM = notional/lev. 잠금(차감) 방향이라 ceil. */
export function initialMargin(notionalValue: Decimal, leverage: number): Decimal {
  if (leverage < 1) throw new Error(`invalid leverage: ${leverage}`);
  return ceil8(notionalValue.div(leverage));
}

/** openLoss: mark 대비 불리한 가격의 즉시 손실분. BUY max(0,p−m)×q, SELL max(0,m−p)×q. */
export function openLoss(side: OrderSide, price: Decimal, mark: Decimal, qty: Decimal): Decimal {
  const adverse = side === OrderSide.BUY ? price.sub(mark) : mark.sub(price);
  if (adverse.lte(0)) return ZERO;
  return ceil8(adverse.mul(qty.abs()));
}

/**
 * 주문 cost(lockedCost) = IM + openLoss + notional×takerBps/10000 (taker 수수료 예약).
 * MARKET은 price에 assumingPrice를 넣는다. reduceOnly/liquidation 주문은 호출하지 않음(cost 0).
 */
export function orderCost(params: {
  side: OrderSide;
  price: Decimal;
  mark: Decimal;
  qty: Decimal;
  leverage: number;
  takerFeeBps: number;
}): Decimal {
  const n = notional(params.price, params.qty);
  const im = initialMargin(n, params.leverage);
  const loss = openLoss(params.side, params.price, params.mark, params.qty);
  const feeReserve = ceil8(n.mul(params.takerFeeBps).div(BPS_DENOMINATOR));
  return im.add(loss).add(feeReserve);
}

/** LIMIT 가격 밴드: p ∈ [m×(1−band), m×(1+band)] (경계 포함). */
export function priceBandCheck(price: Decimal, mark: Decimal, bandPct: Decimal): boolean {
  return price.gte(mark.mul(ONE.sub(bandPct))) && price.lte(mark.mul(ONE.add(bandPct)));
}

/**
 * 청산가. 롱 (EP×Q − margin)/(Q×(1−mmr)), 숏 (EP×Q + margin)/(Q×(1+mmr)).
 * 라운딩은 포지션에 가까운(불리한) 쪽 — 롱 ceil, 숏 floor. qty는 signed.
 */
export function liquidationPrice(
  entryPrice: Decimal,
  qty: Decimal,
  margin: Decimal,
  mmr: Decimal,
): Decimal {
  if (qty.isZero()) throw new Error('liquidationPrice requires non-zero qty');
  const q = qty.abs();
  if (qty.gt(0)) {
    return ceil8(
      entryPrice
        .mul(q)
        .sub(margin)
        .div(q.mul(ONE.sub(mmr))),
    );
  }
  return floor8(
    entryPrice
      .mul(q)
      .add(margin)
      .div(q.mul(ONE.add(mmr))),
  );
}

/**
 * 파산가(마진 전손 가격). 롱 EP − margin/Q, 숏 EP + margin/Q.
 * 라운딩은 EP에서 먼 쪽 — 롱 floor, 숏 ceil. qty는 signed.
 */
export function bankruptcyPrice(entryPrice: Decimal, qty: Decimal, margin: Decimal): Decimal {
  if (qty.isZero()) throw new Error('bankruptcyPrice requires non-zero qty');
  const q = qty.abs();
  return qty.gt(0) ? floor8(entryPrice.sub(margin.div(q))) : ceil8(entryPrice.add(margin.div(q)));
}

/** UPNL = (m − EP) × qty. signed라 롱/숏 모두 성립. signed floor = 지급 floor/차감 ceil. */
export function unrealizedPnl(mark: Decimal, entryPrice: Decimal, qty: Decimal): Decimal {
  return floor8(mark.sub(entryPrice).mul(qty));
}

/** MM = mmr × m × |qty|. ceil — MM이 클수록 청산 판정이 보수적. */
export function maintenanceMargin(mmr: Decimal, mark: Decimal, qty: Decimal): Decimal {
  return ceil8(mmr.mul(mark).mul(qty.abs()));
}

/** marginRatio = MM/(isolatedMargin + UPNL). 분모 ≤ 0이면 null — 즉시 청산 대상. */
export function marginRatio(mm: Decimal, isolatedMargin: Decimal, upnl: Decimal): Decimal | null {
  const equity = isolatedMargin.add(upnl);
  if (equity.lte(0)) return null;
  return mm.div(equity);
}

// ---------- cross 마진 (계정 단위) ----------

/** 한 cross 포지션의 계정 기여분 — 현재 mark 기준. */
export interface CrossLeg {
  isolatedMargin: Decimal; // 포지션 예약 마진
  upnl: Decimal; // signed
  mm: Decimal; // maintenanceMargin
}

/** crossEquity = freeBalance + Σ(margin + UPNL). locked는 제외(보수적). */
export function crossAccountEquity(freeBalance: Decimal, legs: CrossLeg[]): Decimal {
  return legs.reduce((acc, l) => acc.add(l.isolatedMargin).add(l.upnl), freeBalance);
}

/** crossMM = Σ mm. */
export function crossAccountMaintenanceMargin(legs: CrossLeg[]): Decimal {
  return legs.reduce((acc, l) => acc.add(l.mm), ZERO);
}

/** 계정 cross marginRatio = MM/equity. equity ≤ 0이면 null(즉시 대상). leg 0개면 null. */
export function crossAccountMarginRatio(freeBalance: Decimal, legs: CrossLeg[]): Decimal | null {
  if (legs.length === 0) return null;
  const equity = crossAccountEquity(freeBalance, legs);
  if (equity.lte(0)) return null;
  return crossAccountMaintenanceMargin(legs).div(equity);
}

/** 계정 cross 청산 판정: equity ≤ 0 또는 ratio ≥ 1. leg 0개면 비대상. */
export function isCrossAccountLiquidationTarget(freeBalance: Decimal, legs: CrossLeg[]): boolean {
  if (legs.length === 0) return false;
  const equity = crossAccountEquity(freeBalance, legs);
  if (equity.lte(0)) return true;
  return crossAccountMaintenanceMargin(legs).div(equity).gte(1);
}

/**
 * cross 포지션 i의 추정 청산가용 유효 마진:
 * isolatedMargin_i + freeBalance + Σ_{j≠i}(margin_j + UPNL_j − MM_j).
 * 타 포지션을 현재 mark로 고정해 isolated 동형으로 환원한 값 — liquidationPrice에 그대로 투입.
 */
export function crossEffectiveMargin(
  freeBalance: Decimal,
  selfMargin: Decimal,
  others: CrossLeg[],
): Decimal {
  const restSpare = others.reduce(
    (acc, l) => acc.add(l.isolatedMargin).add(l.upnl).sub(l.mm),
    freeBalance,
  );
  return selfMargin.add(restSpare);
}
