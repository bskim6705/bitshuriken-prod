import { FuturesIncomeType, OrderSide } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { ceil8, floor8 } from '@app/shared/decimal';

// 포지션 전이(증량/감량/flip)·잠금 해제·펀딩의 순수 함수 모음 — DB/IO 없음.
// worker는 Position 행을 잠근 트랜잭션 안에서 이 함수의 결과를 그대로 적용한다.

const ZERO = new Decimal(0);
const BPS_DENOMINATOR = new Decimal(10000);

export interface PositionState {
  qty: Decimal; // signed: +롱 −숏
  entryPrice: Decimal;
  isolatedMargin: Decimal;
  leverage: number;
}

export interface Fill {
  price: Decimal;
  qty: Decimal; // 체결량(양수)
  side: OrderSide; // 이 당사자 주문의 side
  feeBps: number;
  lockedCost: Decimal; // 주문 접수 시 잠근 비용. reduceOnly/liquidation은 0
  origQty: Decimal;
  prevExecutedQty: Decimal; // 이 fill 적용 전 주문 누적 체결량 (누적식 lockedRelease용)
  reduceOnly: boolean;
  liquidation: boolean;
  liquidationFeeRate?: Decimal; // liquidation=true면 필수
}

export interface FillContext {
  balance: Decimal; // fill 적용 직전 유저 futures USDT balance (shortfall/flip IM 판정용)
}

export interface IncomeRecord {
  incomeType: FuturesIncomeType;
  income: Decimal; // signed
}

export interface FundTransfer {
  reason: 'LIQUIDATION_FEE';
  amount: Decimal; // 보험기금 balance 적립분 (양수)
}

/** flip IM 부족 — 신규 포지션을 보험기금이 체결가 EP로 인수. margin은 함께 넘어가는 증거금. */
export interface FundTakeover {
  qty: Decimal; // signed
  entryPrice: Decimal;
  margin: Decimal;
}

export interface Shortfall {
  reason: string;
  amount: Decimal; // 부족분 (양수) — worker가 error 로그
}

export interface ApplyFillResult {
  newPosition: PositionState;
  walletDeltas: { balanceDelta: Decimal; lockedDelta: Decimal };
  incomeRecords: IncomeRecord[];
  fundTransfers: FundTransfer[];
  fundTakeover: FundTakeover | null;
  shortfalls: Shortfall[];
}

/**
 * 체결 비례 잠금 해제 — 누적식: floor(L×(prev+q)/X) − floor(L×prev/X).
 * 합산이 telescoping이라 전량 체결 시 Σ == lockedCost (dust lock 금지).
 * 단순 floor(L×q/X)와의 차이는 dust 귀속 위치뿐(나누어지면 동일).
 */
export function lockedReleaseForFill(
  lockedCost: Decimal,
  origQty: Decimal,
  prevExecutedQty: Decimal,
  fillQty: Decimal,
): Decimal {
  if (lockedCost.lte(0)) return ZERO;
  if (origQty.lte(0)) throw new Error('lockedReleaseForFill: origQty must be positive');
  const cumAfter = prevExecutedQty.add(fillQty);
  if (cumAfter.gt(origQty)) {
    throw new Error(
      `lockedReleaseForFill: cumulative executed ${cumAfter.toFixed()} exceeds origQty ${origQty.toFixed()}`,
    );
  }
  const releasedBefore = floor8(lockedCost.mul(prevExecutedQty).div(origQty));
  const releasedAfter = floor8(lockedCost.mul(cumAfter).div(origQty));
  return releasedAfter.sub(releasedBefore);
}

/**
 * terminal 시 잔여 환불 = lockedCost − 총해제분(floor(L×eq/X)).
 * 나누어지면 floor(L×(X−eq)/X)와 동일. 여집합 형태라 Σ lockedReleaseForFill + refund
 * == lockedCost 보존이 항상 성립한다.
 */
export function refundAmount(
  lockedCost: Decimal,
  origQty: Decimal,
  finalExecutedQty: Decimal,
): Decimal {
  if (lockedCost.lte(0)) return ZERO;
  if (origQty.lte(0)) throw new Error('refundAmount: origQty must be positive');
  if (finalExecutedQty.gt(origQty)) {
    throw new Error(
      `refundAmount: executedQty ${finalExecutedQty.toFixed()} exceeds origQty ${origQty.toFixed()}`,
    );
  }
  const released = floor8(lockedCost.mul(finalExecutedQty).div(origQty));
  return lockedCost.sub(released);
}

/** fill 1건을 포지션에 적용해 wallet/income/기금 delta를 산출한다. 적용은 worker 몫. */
export function applyFill(position: PositionState, fill: Fill, ctx: FillContext): ApplyFillResult {
  if (fill.qty.lte(0)) throw new Error('applyFill: fill qty must be positive');
  if (fill.price.lte(0)) throw new Error('applyFill: fill price must be positive');
  if (fill.liquidation && !fill.liquidationFeeRate) {
    throw new Error('applyFill: liquidation fill requires liquidationFeeRate');
  }

  const fillDelta = fill.side === OrderSide.BUY ? fill.qty : fill.qty.neg();
  const lockedRelease = lockedReleaseForFill(
    fill.lockedCost,
    fill.origQty,
    fill.prevExecutedQty,
    fill.qty,
  );

  const increase = position.qty.isZero() || position.qty.isPositive() === fillDelta.isPositive();
  const result = increase
    ? applyIncrease(position, fill, fillDelta, lockedRelease)
    : applyDecreaseOrFlip(position, fill, fillDelta, lockedRelease, ctx);

  // 잔고 음수 진입은 막지 않되 shortfall로 보고 — worker가 error 로그 (fail loudly)
  const projected = ctx.balance.add(result.walletDeltas.balanceDelta);
  if (projected.lt(0) && ctx.balance.gte(0)) {
    result.shortfalls.push({ reason: 'BALANCE_NEGATIVE_AFTER_FILL', amount: projected.neg() });
  }
  return result;
}

function applyIncrease(
  position: PositionState,
  fill: Fill,
  fillDelta: Decimal,
  lockedRelease: Decimal,
): ApplyFillResult {
  const q = fill.qty;
  const p = fill.price;
  const absQty = position.qty.abs();

  // EP 가중평균: (Q×EP + q×p)/(Q+q), floor 8dp
  const newEntryPrice = floor8(absQty.mul(position.entryPrice).add(q.mul(p)).div(absQty.add(q)));
  const marginAdd = ceil8(p.mul(q).div(position.leverage));
  const fee = feeOf(p, q, fill.feeBps);

  const incomeRecords: IncomeRecord[] = [];
  if (fee.gt(0))
    incomeRecords.push({ incomeType: FuturesIncomeType.COMMISSION, income: fee.neg() });

  return {
    newPosition: {
      qty: position.qty.add(fillDelta),
      entryPrice: newEntryPrice,
      isolatedMargin: position.isolatedMargin.add(marginAdd),
      leverage: position.leverage,
    },
    walletDeltas: {
      balanceDelta: lockedRelease.sub(marginAdd).sub(fee),
      lockedDelta: lockedRelease.neg(),
    },
    incomeRecords,
    fundTransfers: [],
    fundTakeover: null,
    shortfalls: [],
  };
}

function applyDecreaseOrFlip(
  position: PositionState,
  fill: Fill,
  fillDelta: Decimal,
  lockedRelease: Decimal,
  ctx: FillContext,
): ApplyFillResult {
  const p = fill.price;
  const absQty = position.qty.abs();
  const sign = position.qty.isNegative() ? -1 : 1;
  const closeQty = Decimal.min(fill.qty, absQty);
  const excessQty = fill.qty.sub(closeQty);

  // RPNL = (p − EP)×c×sign(qty). signed floor = 지급 floor/차감 ceil
  const rpnl = floor8(p.sub(position.entryPrice).mul(closeQty).mul(sign));
  // 마진 비례 해제 floor — 전량 close는 잔여 전부 (floor dust 고착 금지)
  const marginRelease = closeQty.eq(absQty)
    ? position.isolatedMargin
    : floor8(position.isolatedMargin.mul(closeQty).div(absQty));
  const closeFee = feeOf(p, closeQty, fill.feeBps);
  const liqFee = fill.liquidation ? ceil8(p.mul(closeQty).mul(fill.liquidationFeeRate!)) : ZERO;

  const incomeRecords: IncomeRecord[] = [
    { incomeType: FuturesIncomeType.REALIZED_PNL, income: rpnl },
  ];
  const fundTransfers: FundTransfer[] = [];
  if (liqFee.gt(0)) {
    fundTransfers.push({ reason: 'LIQUIDATION_FEE', amount: liqFee });
    incomeRecords.push({ incomeType: FuturesIncomeType.LIQUIDATION_FEE, income: liqFee.neg() });
  }

  // 감량 체결분의 lockedRelease도 환불 (잠금 고착 금지)
  const closeBalanceDelta = marginRelease.add(rpnl).sub(closeFee).sub(liqFee);

  if (excessQty.isZero()) {
    const newQty = position.qty.add(fillDelta);
    if (closeFee.gt(0))
      incomeRecords.push({ incomeType: FuturesIncomeType.COMMISSION, income: closeFee.neg() });
    return {
      newPosition: {
        qty: newQty,
        entryPrice: newQty.isZero() ? ZERO : position.entryPrice,
        isolatedMargin: position.isolatedMargin.sub(marginRelease),
        leverage: position.leverage,
      },
      walletDeltas: {
        balanceDelta: closeBalanceDelta.add(lockedRelease),
        lockedDelta: lockedRelease.neg(),
      },
      incomeRecords,
      fundTransfers,
      fundTakeover: null,
      shortfalls: [],
    };
  }

  // flip: 전량 close 후 초과분을 EP=p의 새 포지션으로 (close-then-open)
  // 수수료는 전체 q 단일 ceil — consume의 Trade.commission과 일치 (분할 ceil 금지)
  const totalFee = feeOf(p, fill.qty, fill.feeBps);
  if (totalFee.gt(0))
    incomeRecords.push({ incomeType: FuturesIncomeType.COMMISSION, income: totalFee.neg() });
  const flipCloseDelta = marginRelease.add(rpnl).sub(liqFee).sub(totalFee);

  const newIM = ceil8(p.mul(excessQty).div(position.leverage));
  // IM 충당: 이 fill의 lockedRelease 우선, 잔여는 balance 환급
  const fromLocked = Decimal.min(lockedRelease, newIM);
  const lockedLeftover = lockedRelease.sub(fromLocked);
  const shortage = newIM.sub(fromLocked);
  const newQty = fillDelta.isPositive() ? excessQty : excessQty.neg();

  // shortage 0이면 balance 부호와 무관하게 정상 flip — 음수 balance에서 0을 꺼낼 일이 없다
  const balanceBeforeIM = ctx.balance.add(flipCloseDelta).add(lockedLeftover);
  if (shortage.lte(Decimal.max(balanceBeforeIM, ZERO))) {
    return {
      newPosition: {
        qty: newQty,
        entryPrice: p,
        isolatedMargin: newIM,
        leverage: position.leverage,
      },
      walletDeltas: {
        balanceDelta: flipCloseDelta.add(lockedLeftover).sub(shortage),
        lockedDelta: lockedRelease.neg(),
      },
      incomeRecords,
      fundTransfers,
      fundTakeover: null,
      shortfalls: [],
    };
  }

  // balance로도 IM 부족 → 신규분을 보험기금이 즉시 인수. fromLocked는 증거금으로 동행
  return {
    newPosition: { qty: ZERO, entryPrice: ZERO, isolatedMargin: ZERO, leverage: position.leverage },
    walletDeltas: {
      balanceDelta: flipCloseDelta.add(lockedLeftover),
      lockedDelta: lockedRelease.neg(),
    },
    incomeRecords,
    fundTransfers,
    fundTakeover: { qty: newQty, entryPrice: p, margin: fromLocked },
    shortfalls: [
      {
        reason: 'FLIP_IM_BALANCE_SHORT',
        amount: shortage.sub(Decimal.max(balanceBeforeIM, ZERO)),
      },
    ],
  };
}

function feeOf(price: Decimal, qty: Decimal, feeBps: number): Decimal {
  return ceil8(price.mul(qty).mul(feeBps).div(BPS_DENOMINATOR));
}

/** 펀딩 지급액 = −F×m×qty (signed). signed floor = 지급 floor/차감 ceil. dust는 음수(기금 귀속). */
export function fundingPayment(rate: Decimal, mark: Decimal, qty: Decimal): Decimal {
  return floor8(rate.neg().mul(mark).mul(qty));
}

export interface FundingApplication {
  balanceDelta: Decimal;
  marginDelta: Decimal;
  reevaluate: boolean; // margin이 줄었으면 marginRatio 재평가 필요
}

/**
 * 펀딩 차감 폭포: balance 우선, 부족분 isolatedMargin.
 * zero-sum 유지를 위해 margin 음수 허용(클램프 금지) — 재평가 플래그가 청산으로 이어진다.
 */
export function applyFundingPayment(payment: Decimal, balance: Decimal): FundingApplication {
  if (payment.gte(0)) {
    return { balanceDelta: payment, marginDelta: ZERO, reevaluate: false };
  }
  const debit = payment.neg();
  const fromBalance = Decimal.min(Decimal.max(balance, ZERO), debit);
  const fromMargin = debit.sub(fromBalance);
  return {
    balanceDelta: fromBalance.neg(),
    marginDelta: fromMargin.neg(),
    reevaluate: fromMargin.gt(0),
  };
}
