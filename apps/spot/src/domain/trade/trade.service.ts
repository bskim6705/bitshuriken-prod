import { Injectable, HttpStatus } from '@nestjs/common';
import { MarketType, Trade } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

const MAX_RECENT_LIMIT = 500;

/** 본인 측 정보만 노출 (상대방 user/order/commission 금지). time = epoch ms. */
export interface MyTrade {
  id: string;
  orderId: string;
  symbol: string;
  market: MarketType;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string | null;
  isBuyer: boolean;
  isMaker: boolean;
  time: number;
}

/** (takerOrderId, price) 그룹 — aggId는 그룹 첫 trade id (seq는 비노출). */
export interface AggTrade {
  aggId: string;
  price: Decimal;
  qty: Decimal;
  firstTradeId: string;
  lastTradeId: string;
  ts: number;
  isBuyerMaker: boolean;
}

interface AggTradeRow {
  first_trade_id: string;
  last_trade_id: string;
  price: Decimal;
  qty: Decimal;
  ts: Date;
  is_buyer_maker: boolean;
}

@Injectable()
export class TradeService {
  constructor(
    private prisma: PrismaService,
    private tickerStats: TickerStatsService,
  ) {}

  /** 본인 체결 이력. self-trade는 maker/taker 양쪽 entry로 분리. */
  async findMyTrades(
    userId: string,
    market: MarketType,
    opts: { symbol?: string; limit: number; endTime?: number },
  ): Promise<MyTrade[]> {
    const safeLimit = Math.min(Math.max(1, opts.limit), MAX_RECENT_LIMIT);
    const rows = await this.prisma.trade.findMany({
      where: {
        tickerMarket: market,
        OR: [{ makerUserId: userId }, { takerUserId: userId }],
        ...(opts.symbol ? { tickerSymbol: opts.symbol } : {}),
        // 커서는 inclusive(lte) — 같은 ms의 경계 행 누락 방지 (FE가 id로 dedupe)
        ...(opts.endTime !== undefined ? { executedAt: { lte: new Date(opts.endTime) } } : {}),
      },
      orderBy: [{ executedAt: 'desc' }, { seq: 'desc' }],
      take: safeLimit,
    });

    return rows.flatMap((t) => {
      const entries: MyTrade[] = [];
      if (t.makerUserId === userId) entries.push(this.toMyTrade(t, true));
      if (t.takerUserId === userId) entries.push(this.toMyTrade(t, false));
      return entries;
    });
  }

  /**
   * Public market data: 특정 ticker의 최근 체결.
   * user 정보(makerUserId/takerUserId)와 seq는 응답에서 제외.
   */
  findRecent(symbol: string, market: MarketType, limit: number) {
    const safeLimit = Math.min(Math.max(1, limit), MAX_RECENT_LIMIT);
    return this.prisma.trade.findMany({
      where: { tickerSymbol: symbol, tickerMarket: market },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
      select: {
        id: true,
        tickerSymbol: true,
        tickerMarket: true,
        takerSide: true,
        price: true,
        qty: true,
        createdAt: true,
      },
    });
  }

  /** (takerOrderId, price) 그룹 집계 — taker sweep의 동일가 fill 묶음. 최근순. */
  async aggTrades(symbol: string, market: MarketType, limit: number): Promise<AggTrade[]> {
    const safeLimit = Math.min(Math.max(1, limit), MAX_RECENT_LIMIT);
    const rows = await this.prisma.$queryRaw<AggTradeRow[]>`
      SELECT (array_agg(t.id ORDER BY t.seq ASC))[1]  AS first_trade_id,
             (array_agg(t.id ORDER BY t.seq DESC))[1] AS last_trade_id,
             t.price                                   AS price,
             sum(t.qty)                                AS qty,
             max(t."executedAt")                       AS ts,
             bool_or(t."takerSide" = 'SELL')           AS is_buyer_maker
      FROM "Trade" t
      WHERE t."tickerSymbol" = ${symbol}
        AND t."tickerMarket" = ${market}::"MarketType"
      GROUP BY t."takerOrderId", t.price
      ORDER BY max(t.seq) DESC
      LIMIT ${safeLimit}
    `;
    return rows.map((r) => ({
      aggId: r.first_trade_id,
      price: r.price,
      qty: r.qty,
      firstTradeId: r.first_trade_id,
      lastTradeId: r.last_trade_id,
      ts: r.ts.getTime(),
      isBuyerMaker: r.is_buyer_maker,
    }));
  }

  /** recent-trades shape + endTime 커서 (executedAt <= endTime, FE가 id로 dedupe). 커서 연속용 executedAt 포함. */
  historicalTrades(symbol: string, market: MarketType, limit: number, endTime?: number) {
    const safeLimit = Math.min(Math.max(1, limit), MAX_RECENT_LIMIT);
    return this.prisma.trade.findMany({
      where: {
        tickerSymbol: symbol,
        tickerMarket: market,
        ...(endTime !== undefined ? { executedAt: { lte: new Date(endTime) } } : {}),
      },
      orderBy: [{ executedAt: 'desc' }, { seq: 'desc' }],
      take: safeLimit,
      select: {
        id: true,
        tickerSymbol: true,
        tickerMarket: true,
        takerSide: true,
        price: true,
        qty: true,
        executedAt: true,
        createdAt: true,
      },
    });
  }

  // ---------- helpers ----------

  private toMyTrade(t: Trade, isMaker: boolean): MyTrade {
    const meta = this.tickerStats.metaOf(t.tickerMarket, t.tickerSymbol);
    if (!meta)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        `Ticker ${t.tickerMarket}/${t.tickerSymbol} not found`,
        HttpStatus.NOT_FOUND,
      );

    const isBuyer = isMaker ? t.takerSide === 'SELL' : t.takerSide === 'BUY';
    return {
      id: t.id,
      orderId: isMaker ? t.makerOrderId : t.takerOrderId,
      symbol: t.tickerSymbol,
      market: t.tickerMarket,
      price: t.price.toFixed(meta.pricePrecision),
      qty: t.qty.toFixed(meta.qtyPrecision),
      quoteQty: t.price.mul(t.qty).toFixed(meta.pricePrecision),
      commission: (isMaker ? t.makerCommission : t.takerCommission).toFixed(8),
      commissionAsset: isMaker ? t.makerCommissionAsset : t.takerCommissionAsset,
      isBuyer,
      isMaker,
      time: t.executedAt.getTime(),
    };
  }
}
