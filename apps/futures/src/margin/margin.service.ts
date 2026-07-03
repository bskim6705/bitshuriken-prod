import { Injectable } from '@nestjs/common';
import { MarketType, Order, OrderSide, OrderStatus, OrderType, TimeInForce } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { assumingPrice, orderCost, priceBandCheck } from '../math/margin-math';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

const ZERO = new Decimal(0);

export interface OrderDraft {
  userId: string;
  clientOrderId: string;
  symbol: string;
  type: OrderType;
  side: OrderSide;
  timeInForce: TimeInForce;
  price: Decimal | null; // MARKET은 null
  qty: Decimal;
  reduceOnly: boolean;
  cost: Decimal; // 잠글 금액. reduceOnly는 0
  lockAssetSymbol: string; // ticker quote (USDT)
}

/** 접수단 마진: 접수가/cost 산정 + 잔고 잠금 + Order insert. NO/CO 발행은 호출자 몫. */
@Injectable()
export class MarginService {
  constructor(private prisma: PrismaService) {}

  /** 접수가: MARKET은 buffer 가정가, limit-like는 가격 밴드 검증 후 주문가. */
  admissionPriceOf(params: {
    type: OrderType;
    side: OrderSide;
    price: Decimal | null;
    mark: Decimal;
    priceBandPct: Decimal;
    marketCostBufferPct: Decimal;
  }): Decimal {
    if (params.type === OrderType.MARKET) {
      return assumingPrice(params.mark, params.side, params.marketCostBufferPct);
    }
    if (params.price === null) {
      throw new DomainException(ErrorCode.INVALID_ORDER_FIELDS, `${params.type} requires price`);
    }
    if (!priceBandCheck(params.price, params.mark, params.priceBandPct)) {
      throw new DomainException(
        ErrorCode.PRICE_OUT_OF_BAND,
        `price must be within ±${params.priceBandPct.mul(100).toFixed(2)}% of mark price ${params.mark.toFixed(8)}`,
      );
    }
    return params.price;
  }

  /** lockedCost = IM + openLoss + taker 수수료 예약. price에는 접수가를 넣는다. */
  costOf(params: {
    side: OrderSide;
    admissionPrice: Decimal;
    mark: Decimal;
    qty: Decimal;
    leverage: number;
    takerFeeBps: number;
  }): Decimal {
    return orderCost({
      side: params.side,
      price: params.admissionPrice,
      mark: params.mark,
      qty: params.qty,
      leverage: params.leverage,
      takerFeeBps: params.takerFeeBps,
    });
  }

  /** cost 조건부 차감-잠금 + Order insert를 한 트랜잭션으로. reduceOnly(cost 0)는 잠금 없음. */
  async createOrder(draft: OrderDraft): Promise<Order> {
    // cost 0이 일반 주문으로 새면 무담보 주문 — 불변식으로 차단
    if (draft.reduceOnly !== draft.cost.isZero()) {
      throw new Error('order cost must be zero iff reduceOnly');
    }

    const data = {
      userId: draft.userId,
      clientOrderId: draft.clientOrderId,
      tickerSymbol: draft.symbol,
      tickerMarket: MarketType.FUTURES,
      type: draft.type,
      side: draft.side,
      timeInForce: draft.timeInForce,
      price: draft.price,
      origQty: draft.qty, // 선물은 base-driven 고정 — origQuoteQty 미사용
      reduceOnly: draft.reduceOnly,
      lockedCost: draft.cost,
      status: OrderStatus.NEW,
    };

    if (draft.cost.isZero()) {
      return this.prisma.order.create({ data });
    }

    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: {
          userId_assetSymbol_marketType: {
            userId: draft.userId,
            assetSymbol: draft.lockAssetSymbol,
            marketType: MarketType.FUTURES,
          },
        },
        select: { userId: true },
      });
      if (!wallet) {
        throw new DomainException(
          ErrorCode.WALLET_NOT_FOUND,
          `Wallet not found for ${draft.lockAssetSymbol}`,
        );
      }

      // 원자적 조건부 차감 — check-then-update는 동시 주문에서 초과 인출 가능
      const debit = await tx.wallet.updateMany({
        where: {
          userId: draft.userId,
          assetSymbol: draft.lockAssetSymbol,
          marketType: MarketType.FUTURES,
          balance: { gte: draft.cost },
        },
        data: {
          balance: { decrement: draft.cost },
          locked: { increment: draft.cost },
        },
      });
      if (debit.count === 0) {
        throw new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');
      }

      return tx.order.create({ data });
    });
  }

  /**
   * 미트리거 stop 주문 insert — 잠금/dispatch 없이 NEW(triggeredAt=null).
   * cost는 발화 시 armTriggeredStop이 잠근다 (접수 시 무잠금).
   */
  async createStopOrder(draft: {
    userId: string;
    clientOrderId: string;
    symbol: string;
    type: OrderType;
    side: OrderSide;
    timeInForce: TimeInForce;
    price: Decimal | null; // *_LIMIT만 값, 그 외 null
    stopPrice: Decimal;
    qty: Decimal;
    reduceOnly: boolean;
  }): Promise<Order> {
    return this.prisma.order.create({
      data: {
        userId: draft.userId,
        clientOrderId: draft.clientOrderId,
        tickerSymbol: draft.symbol,
        tickerMarket: MarketType.FUTURES,
        type: draft.type,
        side: draft.side,
        timeInForce: draft.timeInForce,
        price: draft.price,
        stopPrice: draft.stopPrice,
        origQty: draft.qty,
        reduceOnly: draft.reduceOnly,
        lockedCost: ZERO,
        status: OrderStatus.NEW,
      },
    });
  }

  /**
   * 트리거 발화: 조건부 잠금 + guarded claim(triggeredAt)을 한 트랜잭션으로.
   * 'fired'=무장+잠금 완료(dispatch 필요), 'lost'=취소 선점, 'insufficient'=잔고 부족(거부 필요).
   */
  async armTriggeredStop(params: {
    orderId: string;
    userId: string;
    lockAssetSymbol: string;
    cost: Decimal; // reduceOnly면 0
  }): Promise<'fired' | 'lost' | 'insufficient'> {
    return this.prisma.$transaction(async (tx) => {
      if (!params.cost.isZero()) {
        const debit = await tx.wallet.updateMany({
          where: {
            userId: params.userId,
            assetSymbol: params.lockAssetSymbol,
            marketType: MarketType.FUTURES,
            balance: { gte: params.cost },
          },
          data: {
            balance: { decrement: params.cost },
            locked: { increment: params.cost },
          },
        });
        if (debit.count === 0) return 'insufficient';
      }

      const claim = await tx.order.updateMany({
        where: { id: params.orderId, status: OrderStatus.NEW, triggeredAt: null },
        data: { triggeredAt: new Date(), lockedCost: params.cost },
      });
      if (claim.count === 0) {
        // 취소가 선점 — 방금 잠근 cost를 같은 tx에서 환불
        if (!params.cost.isZero()) {
          await tx.wallet.updateMany({
            where: {
              userId: params.userId,
              assetSymbol: params.lockAssetSymbol,
              marketType: MarketType.FUTURES,
            },
            data: {
              balance: { increment: params.cost },
              locked: { decrement: params.cost },
            },
          });
        }
        return 'lost';
      }
      return 'fired';
    });
  }
}
