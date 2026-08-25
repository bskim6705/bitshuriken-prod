import { Injectable, Logger } from '@nestjs/common';
import { MarketType, OrderSide, OrderType, Prisma, SettlementKind } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { UserService } from '@app/core-domain/user/user.service';
import { isMarketLike } from '@app/shared/order-classify';
import { OrderLeg, WalletLeg } from './settlement.types';

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private prisma: PrismaService,
    private users: UserService,
  ) {}

  /**
   * 한 trade에 대한 settlement event를 append.
   * 수수료는 credit leg(수령 자산)에서 차감, 동일 Decimal을 Trade row에 기록.
   * sourceKey=tradeId UNIQUE 충돌 시 swallow (재처리 멱등).
   * 반환: 신규 insert면 true, 중복(replay 재전달)이면 false.
   */
  async recordTrade(params: {
    tradeId: string;
    market: MarketType;
    tickerSymbol: string;
    baseAssetSymbol: string;
    quoteAssetSymbol: string;
    makerOrderId: string;
    takerOrderId: string;
    makerUserId: string;
    takerUserId: string;
    takerSide: OrderSide;
    price: Decimal;
    qty: Decimal;
    ts: number; // TR 메시지 ts (epoch ms) — Trade.executedAt
  }): Promise<boolean> {
    const quoteUsed = params.price.mul(params.qty);

    // taker.side로 분기. maker는 반대.
    const isTakerBuy = params.takerSide === 'BUY';

    const [makerRates, takerRates] = await Promise.all([
      this.users.feeRatesOf(params.makerUserId, params.market),
      this.users.feeRatesOf(params.takerUserId, params.market),
    ]);

    // commission 자산 = 그 당사자가 수령하는 자산 (BUY → base, SELL → quote)
    const takerGross = isTakerBuy ? params.qty : quoteUsed;
    const makerGross = isTakerBuy ? quoteUsed : params.qty;
    const takerCommission = commissionOf(takerGross, takerRates.takerBps);
    const makerCommission = commissionOf(makerGross, makerRates.makerBps);
    const takerCommissionAsset = isTakerBuy ? params.baseAssetSymbol : params.quoteAssetSymbol;
    const makerCommissionAsset = isTakerBuy ? params.quoteAssetSymbol : params.baseAssetSymbol;

    const taker: WalletLeg = isTakerBuy
      ? {
          userId: params.takerUserId,
          assetSymbol: params.quoteAssetSymbol,
          marketType: params.market,
          lockedDelta: quoteUsed.neg().toString(),
          balanceDelta: '0',
        }
      : {
          userId: params.takerUserId,
          assetSymbol: params.baseAssetSymbol,
          marketType: params.market,
          lockedDelta: params.qty.neg().toString(),
          balanceDelta: '0',
        };

    const takerCredit: WalletLeg = {
      userId: params.takerUserId,
      assetSymbol: takerCommissionAsset,
      marketType: params.market,
      lockedDelta: '0',
      balanceDelta: takerGross.sub(takerCommission).toString(),
    };

    const maker: WalletLeg = isTakerBuy
      ? {
          userId: params.makerUserId,
          assetSymbol: params.baseAssetSymbol,
          marketType: params.market,
          lockedDelta: params.qty.neg().toString(),
          balanceDelta: '0',
        }
      : {
          userId: params.makerUserId,
          assetSymbol: params.quoteAssetSymbol,
          marketType: params.market,
          lockedDelta: quoteUsed.neg().toString(),
          balanceDelta: '0',
        };

    const makerCredit: WalletLeg = {
      userId: params.makerUserId,
      assetSymbol: makerCommissionAsset,
      marketType: params.market,
      lockedDelta: '0',
      balanceDelta: makerGross.sub(makerCommission).toString(),
    };

    const orderLegs: OrderLeg[] = [
      {
        orderId: params.makerOrderId,
        executedQtyDelta: params.qty.toString(),
        cumulativeQuoteQtyDelta: quoteUsed.toString(),
      },
      {
        orderId: params.takerOrderId,
        executedQtyDelta: params.qty.toString(),
        cumulativeQuoteQtyDelta: quoteUsed.toString(),
      },
    ];

    try {
      await this.prisma.$transaction([
        this.prisma.trade.create({
          data: {
            id: params.tradeId,
            tickerSymbol: params.tickerSymbol,
            tickerMarket: params.market,
            makerOrderId: params.makerOrderId,
            takerOrderId: params.takerOrderId,
            makerUserId: params.makerUserId,
            takerUserId: params.takerUserId,
            takerSide: params.takerSide,
            price: params.price,
            qty: params.qty,
            makerCommission,
            takerCommission,
            makerCommissionAsset,
            takerCommissionAsset,
            executedAt: new Date(params.ts),
          },
        }),
        this.prisma.settlementEvent.create({
          data: {
            sourceKey: params.tradeId,
            kind: SettlementKind.TRADE,
            legs: [taker, takerCredit, maker, makerCredit] as unknown as Prisma.InputJsonValue,
            orderLegs: orderLegs as unknown as Prisma.InputJsonValue,
          },
        }),
      ]);
      return true;
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        this.logger.debug(`duplicate trade ${params.tradeId} — skip`);
        return false;
      }
      throw e;
    }
  }

  /**
   * Order가 terminal status에 도달했을 때 잔여 locked를 환불하는 event 생성.
   * orderListId가 있는 주문에는 호출 금지 — 리스트 환불은 recordListRefund 단 1회.
   * dust=0이면 noop. tx 전달 시 호출자 트랜잭션에 합류.
   */
  async recordDustRefund(
    params: {
      orderId: string;
      userId: string;
      market: MarketType;
      baseAssetSymbol: string;
      quoteAssetSymbol: string;
      type: OrderType;
      side: OrderSide;
      price: Decimal | null;
      origQty: Decimal | null;
      origQuoteQty: Decimal | null;
      cumulativeQuoteQty: Decimal;
      executedQty: Decimal;
    },
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const refund = this.computeRefund(params);
    if (refund.amount.lte(0)) return;

    const leg: WalletLeg = {
      userId: params.userId,
      assetSymbol: refund.assetSymbol,
      marketType: params.market,
      lockedDelta: refund.amount.neg().toString(),
      balanceDelta: refund.amount.toString(),
    };

    try {
      await tx.settlementEvent.create({
        data: {
          sourceKey: `dust:${params.orderId}`,
          kind: SettlementKind.DUST_REFUND,
          legs: [leg] as unknown as Prisma.InputJsonValue,
          orderLegs: [] as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        this.logger.debug(`duplicate dust refund event ${params.orderId} — skip`);
        return;
      }
      throw e;
    }
  }

  /**
   * OCO 리스트 종결 시 잔여 잠금 환불 event 생성 (리스트당 1회, sourceKey unique가 이중 INSERT 차단).
   * amount<=0이면 noop. tx 전달 시 호출자 트랜잭션에 합류.
   */
  async recordListRefund(
    params: {
      listId: string;
      userId: string;
      market: MarketType;
      assetSymbol: string;
      amount: Decimal;
    },
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    if (params.amount.lte(0)) return;

    const leg: WalletLeg = {
      userId: params.userId,
      assetSymbol: params.assetSymbol,
      marketType: params.market,
      lockedDelta: params.amount.neg().toString(),
      balanceDelta: params.amount.toString(),
    };

    try {
      await tx.settlementEvent.create({
        data: {
          sourceKey: `listref:${params.listId}`,
          kind: SettlementKind.DUST_REFUND,
          legs: [leg] as unknown as Prisma.InputJsonValue,
          orderLegs: [] as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        this.logger.debug(`duplicate list refund event ${params.listId} — skip`);
        return;
      }
      throw e;
    }
  }

  // ---------- helpers ----------

  private computeRefund(params: {
    type: OrderType;
    side: OrderSide;
    price: Decimal | null;
    origQty: Decimal | null;
    origQuoteQty: Decimal | null;
    cumulativeQuoteQty: Decimal;
    executedQty: Decimal;
    baseAssetSymbol: string;
    quoteAssetSymbol: string;
  }): { assetSymbol: string; amount: Decimal } {
    if (params.side === 'BUY') {
      // market-like 잠금 = origQuoteQty, limit-like 잠금 = price*origQty. 사용 = cqq (quote 환불).
      const locked = isMarketLike(params.type)
        ? new Decimal(params.origQuoteQty ?? 0)
        : new Decimal(params.price ?? 0).mul(params.origQty ?? 0);
      const used = new Decimal(params.cumulativeQuoteQty);
      return { assetSymbol: params.quoteAssetSymbol, amount: locked.sub(used) };
    }

    // SELL 전부: 잠금 = origQty, 사용 = eq (base 환불).
    const locked = new Decimal(params.origQty ?? 0);
    const used = new Decimal(params.executedQty);
    return { assetSymbol: params.baseAssetSymbol, amount: locked.sub(used) };
  }

  private isUniqueViolation(e: unknown): boolean {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
  }
}

function commissionOf(gross: Decimal, bps: number): Decimal {
  return gross.mul(bps).div(10000).toDecimalPlaces(8, Decimal.ROUND_DOWN);
}
