import { OrderSide, OrderType, Position, PositionStatus, TimeInForce } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { TickerMeta } from '@app/core-domain/ticker/ticker-stats.service';
import { isMarketLike, isStopType } from '@app/shared/order-classify';
import { notional } from '../../math/margin-math';
import { CreateFuturesOrderDto } from './dto/create-futures-order.dto';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

// 선물 주문 접수 순수 검증 모음 — DB/IO 없음. 체인 호출 순서는 service가 유지한다.

const ZERO = new Decimal(0);

export interface NormalizedOrderFields {
  price: Decimal | null;
  stopPrice: Decimal | null;
  qty: Decimal;
  timeInForce: TimeInForce;
}

/**
 * 타입별 필드 매트릭스 + precision 검증.
 * price: market-like(MARKET/STOP_LOSS/TAKE_PROFIT)는 금지, 나머지는 필수.
 * stopPrice: stop류(STOP_LOSS(_LIMIT)/TAKE_PROFIT(_LIMIT))는 필수, 나머지는 금지.
 * TIF: market-like=IOC 고정, POST_ONLY=GTC 고정, limit-like(LIMIT/*_LIMIT)는 명시 필수.
 */
export function normalizeOrderFields(
  dto: CreateFuturesOrderDto,
  meta: TickerMeta,
): NormalizedOrderFields {
  const qty = new Decimal(dto.qty);
  if (!qty.isFinite() || qty.lte(0))
    throw new DomainException(ErrorCode.INVALID_QTY, 'qty must be positive');
  if (qty.decimalPlaces() > meta.qtyPrecision) {
    throw new DomainException(
      ErrorCode.INVALID_QTY,
      `qty must have at most ${meta.qtyPrecision} decimals`,
    );
  }

  let price: Decimal | null = null;
  if (isMarketLike(dto.type)) {
    if (dto.price !== undefined)
      throw new DomainException(ErrorCode.INVALID_ORDER_FIELDS, `${dto.type} must not have price`);
  } else {
    if (dto.price === undefined)
      throw new DomainException(ErrorCode.INVALID_ORDER_FIELDS, `${dto.type} requires price`);
    price = parsePrice(dto.price, 'price', meta);
  }

  let stopPrice: Decimal | null = null;
  if (isStopType(dto.type)) {
    if (dto.stopPrice === undefined)
      throw new DomainException(ErrorCode.INVALID_ORDER_FIELDS, `${dto.type} requires stopPrice`);
    stopPrice = parsePrice(dto.stopPrice, 'stopPrice', meta);
  } else if (dto.stopPrice !== undefined) {
    throw new DomainException(ErrorCode.INVALID_ORDER_FIELDS, `${dto.type} must not have stopPrice`);
  }

  return { price, stopPrice, qty, timeInForce: timeInForceOf(dto) };
}

function parsePrice(raw: string, field: 'price' | 'stopPrice', meta: TickerMeta): Decimal {
  const value = new Decimal(raw);
  if (!value.isFinite() || value.lte(0)) {
    throw new DomainException(ErrorCode.INVALID_PRICE, `${field} must be positive`);
  }
  if (value.decimalPlaces() > meta.pricePrecision) {
    throw new DomainException(
      ErrorCode.INVALID_PRICE,
      `${field} must have at most ${meta.pricePrecision} decimals`,
    );
  }
  return value;
}

/** stop 트리거 조건 (Binance 동일). 선물은 기준가 = mark price. 즉시-트리거 검사와 공유. */
export function stopTriggered(
  type: OrderType,
  side: OrderSide,
  stopPrice: Decimal,
  refPrice: Decimal,
): boolean {
  const isStopLoss = type === OrderType.STOP_LOSS || type === OrderType.STOP_LOSS_LIMIT;
  if (isStopLoss) {
    return side === OrderSide.BUY ? refPrice.gte(stopPrice) : refPrice.lte(stopPrice);
  }
  // TAKE_PROFIT(_LIMIT)
  return side === OrderSide.BUY ? refPrice.lte(stopPrice) : refPrice.gte(stopPrice);
}

function timeInForceOf(dto: CreateFuturesOrderDto): TimeInForce {
  switch (dto.type) {
    case OrderType.MARKET:
    case OrderType.STOP_LOSS:
    case OrderType.TAKE_PROFIT:
      if (dto.timeInForce !== undefined && dto.timeInForce !== TimeInForce.IOC) {
        throw new DomainException(
          ErrorCode.INVALID_TIME_IN_FORCE,
          `${dto.type} timeInForce must be IOC`,
        );
      }
      return TimeInForce.IOC;
    case OrderType.POST_ONLY:
      if (dto.timeInForce !== undefined && dto.timeInForce !== TimeInForce.GTC) {
        throw new DomainException(
          ErrorCode.INVALID_TIME_IN_FORCE,
          'POST_ONLY timeInForce must be GTC',
        );
      }
      return TimeInForce.GTC;
    default:
      if (dto.timeInForce === undefined) {
        throw new DomainException(
          ErrorCode.INVALID_TIME_IN_FORCE,
          `${dto.type} requires timeInForce`,
        );
      }
      return dto.timeInForce;
  }
}

/** LIQUIDATING 포지션은 주문 접수/취소/설정 변경 전부 거부. */
export function assertNotLiquidating(position: Pick<Position, 'status'> | null): void {
  if (position?.status === PositionStatus.LIQUIDATING) {
    throw new DomainException(ErrorCode.POSITION_LIQUIDATING, 'Position is liquidating');
  }
}

/** 추정 notional ≥ minNotional. MARKET 추정은 mark 기준 — 호출자가 산정. */
export function assertMinNotional(estNotional: Decimal, meta: TickerMeta): void {
  if (meta.minNotional.gt(0) && estNotional.lt(meta.minNotional)) {
    throw new DomainException(
      ErrorCode.MIN_NOTIONAL_NOT_MET,
      `order notional must be at least ${meta.minNotional.toFixed(8)} ${meta.quoteAsset}`,
    );
  }
}

export interface OpenOrderQtyRow {
  price: Decimal | null;
  origQty: Decimal | null;
  executedQty: Decimal;
  side: OrderSide;
}

/**
 * 방향별 노출 캡: 신규 주문 방향의 노출(같은 방향 포지션 + 같은 방향 미체결(reduceOnly 제외)
 * 잔량 + 신규) ≤ maxNotional. 반대 방향 포지션·미체결은 이 방향의 노출을 늘리지 않으므로
 * 세지 않는다(상쇄도 하지 않는다 — 보수적). 방향 무시 합산은 양쪽 호가를 걸치는 계정(마켓
 * 메이커)의 정상 주문을 자기 반대편 잔량 때문에 거절한다.
 */
export function assertWithinMaxNotional(params: {
  position: Pick<Position, 'qty'> | null;
  mark: Decimal;
  openOrders: OpenOrderQtyRow[];
  newSide: OrderSide;
  newNotional: Decimal;
  maxNotional: Decimal;
}): void {
  const posQty = params.position?.qty ?? ZERO;
  const posSameDirection =
    (params.newSide === OrderSide.BUY && posQty.gt(0)) ||
    (params.newSide === OrderSide.SELL && posQty.lt(0));
  let total = posSameDirection ? notional(params.mark, posQty) : ZERO;
  for (const o of params.openOrders) {
    if (o.side !== params.newSide) continue;
    const remaining = (o.origQty ?? ZERO).sub(o.executedQty);
    if (remaining.lte(0)) continue;
    total = total.add(notional(o.price ?? params.mark, remaining));
  }
  if (total.add(params.newNotional).gt(params.maxNotional)) {
    throw new DomainException(
      ErrorCode.MAX_NOTIONAL_EXCEEDED,
      `${params.newSide} exposure would exceed maxNotional ${params.maxNotional.toFixed(8)}`,
    );
  }
}

/** reduceOnly는 보유 포지션의 청산 방향이어야 한다. closingSide 반환. */
export function assertReduceOnlySide(
  side: OrderSide,
  position: Pick<Position, 'qty'> | null,
): OrderSide {
  if (!position || position.qty.isZero()) {
    throw new DomainException(
      ErrorCode.REDUCE_ONLY_REJECTED,
      'reduceOnly requires an open position',
    );
  }
  const closingSide = position.qty.gt(0) ? OrderSide.SELL : OrderSide.BUY;
  if (side !== closingSide) {
    throw new DomainException(
      ErrorCode.REDUCE_ONLY_REJECTED,
      `reduceOnly on this position requires ${closingSide} side`,
    );
  }
  return closingSide;
}

/** Σ(reduceOnly open 잔량) + 신규 qty ≤ |position.qty|. */
export function assertReduceOnlyCapacity(params: {
  qty: Decimal;
  positionQty: Decimal;
  openReduceOnly: Pick<OpenOrderQtyRow, 'origQty' | 'executedQty'>[];
}): void {
  let reserved = ZERO;
  for (const o of params.openReduceOnly) {
    reserved = reserved.add((o.origQty ?? ZERO).sub(o.executedQty));
  }
  if (reserved.add(params.qty).gt(params.positionQty.abs())) {
    throw new DomainException(
      ErrorCode.REDUCE_ONLY_EXCEEDED,
      'reduceOnly qty exceeds remaining position',
    );
  }
}
