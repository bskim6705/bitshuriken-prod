import { OrderSide, OrderType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { TickerMeta } from '@app/core-domain/ticker/ticker-stats.service';
import { isLimitLike } from '@app/shared/order-classify';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { SPOT_PRICE_BAND_PCT } from '@app/shared/constants/trading-protection';
import { isKrwTickAligned, krwTickSize } from '@app/shared/constants/krw-tick';

const BAND_PCT = new Decimal(SPOT_PRICE_BAND_PCT);
const ONE = new Decimal(1);

// raw 입력 필드 조합 (CreateOrderDto 구조 부분집합 — 순수 모듈이라 DTO 클래스 비의존)
export interface OrderFieldsInput {
  type: OrderType;
  side: OrderSide;
  price?: string;
  stopPrice?: string;
  origQty?: string;
  origQuoteQty?: string;
}

export interface MetaValidationInput {
  type: OrderType;
  side: OrderSide;
  price: Decimal | null;
  stopPrice: Decimal | null;
  origQty: Decimal | null;
  origQuoteQty: Decimal | null;
  meta: TickerMeta;
  // minNotional 추정용 (market-like SELL). null이면 해당 검사 생략.
  lastPrice: Decimal | null;
  // 가격 밴드 기준가 (5m 가중평균 or last). null이면(신규 상장 등) 밴드 검사 생략.
  bandRefPrice: Decimal | null;
}

/** 타입별 필수/금지 필드 매트릭스. */
export function validateDtoCombination(dto: OrderFieldsInput): void {
  const { type, side, price, origQty, origQuoteQty, stopPrice } = dto;

  switch (type) {
    case OrderType.LIMIT:
    case OrderType.POST_ONLY:
      if (!price || !origQty) {
        throw new DomainException(
          ErrorCode.INVALID_ORDER_FIELDS,
          `${type} requires price and origQty`,
        );
      }
      if (origQuoteQty)
        throw new DomainException(
          ErrorCode.INVALID_ORDER_FIELDS,
          `${type} must not have origQuoteQty`,
        );
      if (stopPrice)
        throw new DomainException(
          ErrorCode.INVALID_ORDER_FIELDS,
          `${type} must not have stopPrice`,
        );
      return;

    case OrderType.MARKET:
      if (price)
        throw new DomainException(ErrorCode.INVALID_ORDER_FIELDS, 'MARKET must not have price');
      if (stopPrice)
        throw new DomainException(ErrorCode.INVALID_ORDER_FIELDS, 'MARKET must not have stopPrice');
      validateMarketLikeQty(type, side, origQty, origQuoteQty);
      return;

    case OrderType.STOP_LOSS:
    case OrderType.TAKE_PROFIT:
      if (!stopPrice)
        throw new DomainException(ErrorCode.INVALID_ORDER_FIELDS, `${type} requires stopPrice`);
      if (price)
        throw new DomainException(ErrorCode.INVALID_ORDER_FIELDS, `${type} must not have price`);
      validateMarketLikeQty(type, side, origQty, origQuoteQty);
      return;

    case OrderType.STOP_LOSS_LIMIT:
    case OrderType.TAKE_PROFIT_LIMIT:
      if (!stopPrice || !price || !origQty) {
        throw new DomainException(
          ErrorCode.INVALID_ORDER_FIELDS,
          `${type} requires stopPrice, price and origQty`,
        );
      }
      if (origQuoteQty)
        throw new DomainException(
          ErrorCode.INVALID_ORDER_FIELDS,
          `${type} must not have origQuoteQty`,
        );
      return;

    default:
      throw new DomainException(
        ErrorCode.INVALID_ORDER_FIELDS,
        `Unsupported order type ${String(type)}`,
      );
  }
}

/** market-like qty 규칙: SELL은 origQty(base), BUY는 origQuoteQty(quote)만. */
function validateMarketLikeQty(
  type: OrderType,
  side: OrderSide,
  origQty?: string,
  origQuoteQty?: string,
): void {
  if (side === OrderSide.SELL) {
    if (!origQty)
      throw new DomainException(ErrorCode.INVALID_ORDER_FIELDS, `${type} SELL requires origQty`);
    if (origQuoteQty)
      throw new DomainException(
        ErrorCode.INVALID_ORDER_FIELDS,
        `${type} SELL must not have origQuoteQty`,
      );
  } else {
    if (!origQuoteQty)
      throw new DomainException(
        ErrorCode.INVALID_ORDER_FIELDS,
        `${type} BUY requires origQuoteQty`,
      );
    if (origQty)
      throw new DomainException(
        ErrorCode.INVALID_ORDER_FIELDS,
        `${type} BUY must not have origQty`,
      );
  }
}

/**
 * tick/step/minNotional 공통 검증. 엔진으로 가는 모든 placement 경로(일반/stop/OCO 레그)가 통과해야 한다.
 */
export function validateAgainstMeta(input: MetaValidationInput): void {
  const { meta } = input;
  // KRW-quote 마켓은 Upbit 계단식 호가단위 — 소수 자릿수 대신 tier tick 정렬로 검증 (ADR-066).
  const krw = meta.quoteAsset === 'KRW';

  if (input.price !== null) {
    requirePositive(input.price, 'price');
    if (krw) {
      if (!isKrwTickAligned(input.price)) {
        throw new DomainException(
          ErrorCode.INVALID_PRICE,
          `price must be a multiple of ${krwTickSize(input.price).toFixed()} KRW at this price`,
        );
      }
    } else if (input.price.decimalPlaces() > meta.pricePrecision) {
      throw new DomainException(
        ErrorCode.INVALID_PRICE,
        `price must have at most ${meta.pricePrecision} decimals`,
      );
    }
    // PERCENT_PRICE 밴드 — limit 호가만(stopPrice·MARKET 제외). 기준가 없으면 생략.
    if (input.bandRefPrice !== null) {
      const lo = input.bandRefPrice.mul(ONE.sub(BAND_PCT));
      const hi = input.bandRefPrice.mul(ONE.add(BAND_PCT));
      if (input.price.lt(lo) || input.price.gt(hi)) {
        throw new DomainException(
          ErrorCode.PRICE_OUT_OF_BAND,
          `price must be within ±${BAND_PCT.mul(100).toFixed(0)}% of ${input.bandRefPrice.toFixed(meta.pricePrecision)}`,
        );
      }
    }
  }
  if (input.stopPrice !== null) {
    requirePositive(input.stopPrice, 'stopPrice');
    if (krw) {
      if (!isKrwTickAligned(input.stopPrice)) {
        throw new DomainException(
          ErrorCode.INVALID_PRICE,
          `stopPrice must be a multiple of ${krwTickSize(input.stopPrice).toFixed()} KRW at this price`,
        );
      }
    } else if (input.stopPrice.decimalPlaces() > meta.pricePrecision) {
      throw new DomainException(
        ErrorCode.INVALID_PRICE,
        `stopPrice must have at most ${meta.pricePrecision} decimals`,
      );
    }
  }
  if (input.origQty !== null) {
    requirePositive(input.origQty, 'origQty');
    if (input.origQty.decimalPlaces() > meta.qtyPrecision) {
      throw new DomainException(
        ErrorCode.INVALID_QTY,
        `origQty must have at most ${meta.qtyPrecision} decimals`,
      );
    }
  }
  if (input.origQuoteQty !== null) {
    requirePositive(input.origQuoteQty, 'origQuoteQty');
    // Kafka 메시지는 int*10^8 — 8자리 초과는 직렬화 불능.
    if (input.origQuoteQty.decimalPlaces() > 8) {
      throw new DomainException(ErrorCode.INVALID_QTY, 'origQuoteQty must have at most 8 decimals');
    }
  }

  if (meta.minNotional.lte(0)) return;

  let notional: Decimal | null = null;
  if (isLimitLike(input.type)) {
    notional = input.price!.mul(input.origQty!);
  } else if (input.side === 'BUY') {
    notional = input.origQuoteQty!;
  } else if (input.lastPrice !== null) {
    // market-like SELL: notional = last price 추정. 체결 이력 전무(last null)면 추정 불가 →
    // placement 단계 minNotional 검사 생략(의도된 동작). 빈 책이면 어차피 미체결, dust는 정산이 처리.
    notional = input.lastPrice.mul(input.origQty!);
  }
  if (notional !== null && notional.lt(meta.minNotional)) {
    throw new DomainException(
      ErrorCode.MIN_NOTIONAL_NOT_MET,
      `order notional must be at least ${meta.minNotional.toFixed(8)} ${meta.quoteAsset}`,
    );
  }
}

/** stop 트리거 조건 (Binance 동일, last trade price 기준). placement 즉시-트리거 검사와 공유. */
export function stopTriggered(
  type: OrderType,
  side: OrderSide,
  stopPrice: Decimal,
  lastPrice: Decimal,
): boolean {
  const isStopLoss = type === 'STOP_LOSS' || type === 'STOP_LOSS_LIMIT';
  if (isStopLoss) {
    return side === 'BUY' ? lastPrice.gte(stopPrice) : lastPrice.lte(stopPrice);
  }
  // TAKE_PROFIT(_LIMIT)
  return side === 'BUY' ? lastPrice.lte(stopPrice) : lastPrice.gte(stopPrice);
}

function requirePositive(value: Decimal, field: string): void {
  if (value.lte(0)) {
    // price 계열 필드는 INVALID_PRICE, qty 계열은 INVALID_QTY
    const code = field.toLowerCase().includes('price')
      ? ErrorCode.INVALID_PRICE
      : ErrorCode.INVALID_QTY;
    throw new DomainException(code, `${field} must be positive`);
  }
}
