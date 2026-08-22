import { Injectable } from '@nestjs/common';
import { FundingTxType, FuturesIncomeType, MarketType, OrderSide, Prisma } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const TRADE = 'TRADE';

const FUNDING_TYPES = new Set<string>(Object.values(FundingTxType));
const INCOME_TYPES = new Set<string>(Object.values(FuturesIncomeType));

export interface HistoryQuery {
  type?: string;
  asset?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

export interface UnifiedRow {
  id: string;
  type: string; // DEPOSIT|WITHDRAWAL|TRANSFER|REALIZED_PNL|COMMISSION|FUNDING_FEE|... |TRADE
  asset: string;
  amount: string; // signed (지급 + / 차감 −); TRADE는 base qty(BUY +, SELL −)
  market: MarketType | null;
  time: number;
  detail: Record<string, unknown>;
}

/**
 * 통합 변동내역 — FundingTx(입출금/이체) + FuturesIncome(손익/펀딩/수수료) + Trade(체결)를
 * 조회 시 합쳐 시간순으로. type 미지정=섞어서(All), type 지정=해당 도메인만(각각).
 */
@Injectable()
export class UnifiedHistoryService {
  constructor(private prisma: PrismaService) {}

  async list(userId: string, q: HistoryQuery): Promise<UnifiedRow[]> {
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const type = this.validateType(q.type);
    const time = this.timeRange(q.startTime, q.endTime);

    const wantFunding = type === undefined || FUNDING_TYPES.has(type);
    const wantIncome = type === undefined || INCOME_TYPES.has(type);
    const wantTrade = type === undefined || type === TRADE;

    const batches = await Promise.all([
      wantFunding ? this.funding(userId, q, type, time, limit) : Promise.resolve([]),
      wantIncome ? this.income(userId, q, type, time, limit) : Promise.resolve([]),
      wantTrade ? this.trades(userId, q, time, limit) : Promise.resolve([]),
    ]);

    return batches
      .flat()
      .sort((a, b) => b.time - a.time)
      .slice(0, limit);
  }

  private async funding(
    userId: string,
    q: HistoryQuery,
    type: string | undefined,
    time: Prisma.DateTimeFilter | undefined,
    limit: number,
  ): Promise<UnifiedRow[]> {
    const where: Prisma.FundingTxWhereInput = { userId };
    if (time) where.createdAt = time;
    if (type && FUNDING_TYPES.has(type)) where.type = type as FundingTxType;
    if (q.asset) where.assetSymbol = q.asset;

    const rows = await this.prisma.fundingTx.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => {
      // 차감(−): WITHDRAWAL, 그리고 보낸 쪽 SUBACCOUNT_TRANSFER(fromMarket만 설정)
      const isOutbound =
        r.type === FundingTxType.WITHDRAWAL ||
        (r.type === FundingTxType.SUBACCOUNT_TRANSFER && r.toMarket === null);
      const signed = isOutbound ? r.qty.neg() : r.qty;
      return {
        id: r.id,
        type: r.type,
        asset: r.assetSymbol,
        amount: signed.toFixed(8),
        market: r.toMarket ?? r.fromMarket ?? null,
        time: r.createdAt.getTime(),
        detail: {
          fromMarket: r.fromMarket,
          toMarket: r.toMarket,
          status: r.status,
          counterpartyUserId: r.counterpartyUserId,
        },
      };
    });
  }

  private async income(
    userId: string,
    q: HistoryQuery,
    type: string | undefined,
    time: Prisma.DateTimeFilter | undefined,
    limit: number,
  ): Promise<UnifiedRow[]> {
    const where: Prisma.FuturesIncomeWhereInput = { userId };
    if (time) where.createdAt = time;
    if (type && INCOME_TYPES.has(type)) where.incomeType = type as FuturesIncomeType;
    // income은 USDT 표시 — asset 필터가 USDT가 아니면 심볼 prefix로 best-effort
    if (q.asset && q.asset !== 'USDT') where.tickerSymbol = { startsWith: q.asset };

    const rows = await this.prisma.futuresIncome.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.incomeType,
      asset: 'USDT',
      amount: r.income.toFixed(8),
      market: MarketType.FUTURES,
      time: r.createdAt.getTime(),
      detail: { tickerSymbol: r.tickerSymbol },
    }));
  }

  private async trades(
    userId: string,
    q: HistoryQuery,
    time: Prisma.DateTimeFilter | undefined,
    limit: number,
  ): Promise<UnifiedRow[]> {
    const where: Prisma.TradeWhereInput = {
      OR: [{ makerUserId: userId }, { takerUserId: userId }],
    };
    if (time) where.executedAt = time;
    if (q.asset) where.tickerSymbol = { startsWith: q.asset };

    const rows = await this.prisma.trade.findMany({
      where,
      orderBy: { executedAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => {
      const isMaker = r.makerUserId === userId;
      const userSide = isMaker
        ? r.takerSide === OrderSide.BUY
          ? OrderSide.SELL
          : OrderSide.BUY
        : r.takerSide;
      const qty = userSide === OrderSide.BUY ? r.qty : r.qty.neg();
      return {
        id: r.id,
        type: TRADE,
        asset: r.tickerSymbol,
        amount: qty.toFixed(8),
        market: r.tickerMarket,
        time: r.executedAt.getTime(),
        detail: {
          symbol: r.tickerSymbol,
          side: userSide,
          isMaker,
          price: r.price.toFixed(8),
          quoteQty: r.price.mul(r.qty).toFixed(8),
          commission: (isMaker ? r.makerCommission : r.takerCommission).toFixed(8),
          commissionAsset: isMaker ? r.makerCommissionAsset : r.takerCommissionAsset,
        },
      };
    });
  }

  private validateType(type?: string): string | undefined {
    if (type === undefined) return undefined;
    if (!FUNDING_TYPES.has(type) && !INCOME_TYPES.has(type) && type !== TRADE) {
      throw new DomainException(ErrorCode.INVALID_PARAMETER, `Invalid type: ${type}`);
    }
    return type;
  }

  private timeRange(startTime?: number, endTime?: number): Prisma.DateTimeFilter | undefined {
    if (startTime === undefined && endTime === undefined) return undefined;
    const filter: Prisma.DateTimeFilter = {};
    if (startTime !== undefined) filter.gte = new Date(startTime);
    if (endTime !== undefined) filter.lte = new Date(endTime);
    return filter;
  }
}
