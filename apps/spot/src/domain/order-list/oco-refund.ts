import { OrderListStatus, OrderSide, OrderStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

/** 레그별 최종 eq/cqq — OU 메시지 값 또는 (drain 후) DB 값. */
export interface LegFinalValues {
  eq: Decimal;
  cqq: Decimal;
}

/**
 * 리스트 종결 산정 (순수). 환불 = lockAmount − used,
 * used는 BUY면 cqq 합(quote), SELL이면 eq 합(base).
 */
export function resolveFinalization(args: {
  side: OrderSide;
  lockAmount: Decimal;
  limitStatus: OrderStatus;
  stopStatus: OrderStatus;
  limitVals: LegFinalValues;
  stopVals: LegFinalValues;
}): { finalStatus: OrderListStatus; refundAmount: Decimal } {
  const bothRejectedNoFill =
    args.limitStatus === 'REJECTED' &&
    args.stopStatus === 'REJECTED' &&
    args.limitVals.eq.isZero() &&
    args.stopVals.eq.isZero();

  const used =
    args.side === 'BUY'
      ? args.limitVals.cqq.add(args.stopVals.cqq)
      : args.limitVals.eq.add(args.stopVals.eq);

  return {
    finalStatus: bothRejectedNoFill ? 'REJECTED' : 'ALL_DONE',
    refundAmount: args.lockAmount.sub(used),
  };
}
