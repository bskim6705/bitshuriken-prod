import { OrderSide, OrderType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { TickerMeta } from '@app/core-domain/ticker/ticker-stats.service';
import { isMarketLike } from '@app/shared/order-classify';

// 순수 잠금 산식 — DB/IO 없음. 환불 산식은 settlement.computeRefund 소유(잠금-사용 대칭).

export interface OrderLock {
  assetSymbol: string;
  amount: Decimal;
}

/** 주문 접수 시 잠글 자산/금액. 필드 존재는 호출 전 validateDtoCombination이 보장. */
export function lockFor(params: {
  type: OrderType;
  side: OrderSide;
  price: Decimal | null;
  origQty: Decimal | null;
  origQuoteQty: Decimal | null;
  meta: TickerMeta;
}): OrderLock {
  const { type, side, price, origQty, origQuoteQty, meta } = params;
  if (side === OrderSide.BUY) {
    if (isMarketLike(type)) {
      return { assetSymbol: meta.quoteAsset, amount: origQuoteQty! };
    }
    // limit-like BUY: price * origQty quote
    return { assetSymbol: meta.quoteAsset, amount: price!.mul(origQty!) };
  }
  // SELL: origQty base
  return { assetSymbol: meta.baseAsset, amount: origQty! };
}
