import { Injectable, HttpStatus } from '@nestjs/common';
import {
  FuturesIncomeType,
  MarginMode,
  MarketType,
  Order,
  OrderStatus,
  Trade,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { UserService } from '@app/core-domain/user/user.service';
import { FuturesConfigService } from '../../config/futures-config.service';
import { MarkPriceService } from '../../mark-price/mark-price.service';
import {
  type CrossLeg,
  crossAccountMarginRatio,
  crossEffectiveMargin,
  liquidationPrice,
  maintenanceMargin,
  marginRatio,
  unrealizedPnl,
} from '../../math/margin-math';
import { floor8 } from '@app/shared/decimal';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

const ZERO = new Decimal(0);
const BPS_DENOMINATOR = new Decimal(10000);

const OPEN_STATUSES: OrderStatus[] = ['NEW', 'OPEN', 'PARTIAL'];
const MAX_HISTORY_LIMIT = 500;

/** 본인 측 정보만 노출 (상대방 user/order/commission 금지). time = epoch ms. */
export interface FuturesMyTrade {
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

@Injectable()
export class FuturesAccountService {
  constructor(
    private prisma: PrismaService,
    private tickerStats: TickerStatsService,
    private futuresConfig: FuturesConfigService,
    private markPrice: MarkPriceService,
    private users: UserService,
  ) {}

  findBalances(userId: string) {
    return this.prisma.wallet.findMany({
      where: { userId, marketType: MarketType.FUTURES },
      orderBy: { assetSymbol: 'asc' },
    });
  }

  /**
   * 포지션 + 파생값(mark/UPNL/청산가/marginRatio). 행 존재 = qty≠0 또는 leverage/mode 설정 이력.
   * ISOLATED는 포지션 단일 행 파생, CROSS는 계정 단위(marginRatio 공유 + 추정 청산가).
   */
  async findPositions(userId: string, symbol?: string) {
    // cross marginRatio/추정 청산가는 계정 전 포지션 집계에 의존 — 단일 심볼 조회도 전 행으로 계산 후 필터
    const rows = await this.prisma.position.findMany({
      where: { userId },
      orderBy: { tickerSymbol: 'asc' },
    });

    // 각 행의 mark/mmr/UPNL/MM 선계산
    const enriched = await Promise.all(
      rows.map(async (p) => {
        const mark = this.markPrice.tryGetMark(p.tickerSymbol);
        let mmr: Decimal | null = null;
        let upnl: Decimal | null = null;
        let mm: Decimal | null = null;
        if (!p.qty.isZero()) {
          mmr = (await this.futuresConfig.configOf(p.tickerSymbol)).mmr;
          if (mark !== null) {
            upnl = unrealizedPnl(mark, p.entryPrice, p.qty);
            mm = maintenanceMargin(mmr, mark, p.qty);
          }
        }
        return { p, mark, mmr, upnl, mm };
      }),
    );

    // cross 계정 집계 — mark가 형성된 cross 포지션만
    const crossLegs = enriched
      .filter((e) => e.p.marginMode === MarginMode.CROSS && e.upnl !== null && e.mm !== null)
      .map((e) => ({
        symbol: e.p.tickerSymbol,
        leg: { isolatedMargin: e.p.isolatedMargin, upnl: e.upnl!, mm: e.mm! } as CrossLeg,
      }));

    let crossFreeBalance = ZERO;
    let crossRatio: string | null = null;
    if (crossLegs.length > 0) {
      const quoteAsset = this.tickerStats.metaOf(
        MarketType.FUTURES,
        crossLegs[0].symbol,
      )?.quoteAsset;
      crossFreeBalance = quoteAsset ? await this.freeFuturesBalance(userId, quoteAsset) : ZERO;
      crossRatio =
        crossAccountMarginRatio(
          crossFreeBalance,
          crossLegs.map((c) => c.leg),
        )?.toFixed(8) ?? null;
    }

    const selected = symbol ? enriched.filter((e) => e.p.tickerSymbol === symbol) : enriched;
    return selected.map(({ p, mark, mmr, upnl, mm }) => {
      let liqPrice: string | null = null;
      let ratio: string | null = null;
      if (!p.qty.isZero() && mmr !== null) {
        if (p.marginMode === MarginMode.CROSS) {
          ratio = crossRatio;
          if (mark !== null) {
            const others = crossLegs.filter((c) => c.symbol !== p.tickerSymbol).map((c) => c.leg);
            const effMargin = crossEffectiveMargin(crossFreeBalance, p.isolatedMargin, others);
            const lp = liquidationPrice(p.entryPrice, p.qty, effMargin, mmr);
            liqPrice = lp.gt(0) ? lp.toFixed(8) : null; // 음수=해당 포지션 단독으론 청산 불가
          }
        } else {
          liqPrice = liquidationPrice(p.entryPrice, p.qty, p.isolatedMargin, mmr).toFixed(8);
          if (mark !== null && mm !== null && upnl !== null) {
            ratio = marginRatio(mm, p.isolatedMargin, upnl)?.toFixed(8) ?? null;
          }
        }
      }

      return {
        symbol: p.tickerSymbol,
        qty: p.qty.toFixed(8),
        entryPrice: p.entryPrice.toFixed(8),
        isolatedMargin: p.isolatedMargin.toFixed(8),
        leverage: p.leverage,
        marginMode: p.marginMode,
        status: p.status,
        markPrice: mark?.toFixed(8) ?? null,
        unrealizedPnl: upnl?.toFixed(8) ?? null,
        liquidationPrice: liqPrice,
        marginRatio: ratio,
        updatedAt: p.updatedAt,
      };
    });
  }

  /** 유저 FUTURES quote 지갑 free balance — cross 담보. 행 없으면 0. */
  private async freeFuturesBalance(userId: string, assetSymbol: string): Promise<Decimal> {
    const wallet = await this.prisma.wallet.findUnique({
      where: {
        userId_assetSymbol_marketType: { userId, assetSymbol, marketType: MarketType.FUTURES },
      },
      select: { balance: true },
    });
    return wallet?.balance ?? ZERO;
  }

  findOpenOrders(userId: string, symbol?: string) {
    return this.prisma.order.findMany({
      where: {
        userId,
        tickerMarket: MarketType.FUTURES,
        status: { in: OPEN_STATUSES },
        ...(symbol ? { tickerSymbol: symbol } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** ref = 주문 uuid 우선, 없으면 본인 FUTURES clientOrderId로 폴백 해석. */
  async findOrder(userId: string, ref: string): Promise<Order> {
    let order = await this.prisma.order.findUnique({ where: { id: ref } });
    if (!order) {
      order = await this.prisma.order.findFirst({
        where: { userId, tickerMarket: MarketType.FUTURES, clientOrderId: ref },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!order || order.tickerMarket !== MarketType.FUTURES)
      throw new DomainException(ErrorCode.ORDER_NOT_FOUND, 'Order not found', HttpStatus.NOT_FOUND);
    if (order.userId !== userId)
      throw new DomainException(ErrorCode.FORBIDDEN, 'Not your order', HttpStatus.FORBIDDEN);
    return order;
  }

  findOrders(userId: string, opts: { symbol?: string; limit: number; endTime?: number }) {
    const safeLimit = Math.min(Math.max(1, opts.limit), MAX_HISTORY_LIMIT);
    return this.prisma.order.findMany({
      where: {
        userId,
        tickerMarket: MarketType.FUTURES,
        ...(opts.symbol ? { tickerSymbol: opts.symbol } : {}),
        // 커서는 inclusive(lte) — 같은 ms의 경계 행 누락 방지 (FE가 id로 dedupe)
        ...(opts.endTime !== undefined ? { createdAt: { lte: new Date(opts.endTime) } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: safeLimit,
    });
  }

  /** 본인 체결 이력. self-trade는 maker/taker 양쪽 entry로 분리. */
  async findMyTrades(
    userId: string,
    opts: { symbol?: string; limit: number; endTime?: number },
  ): Promise<FuturesMyTrade[]> {
    const safeLimit = Math.min(Math.max(1, opts.limit), MAX_HISTORY_LIMIT);
    const rows = await this.prisma.trade.findMany({
      where: {
        tickerMarket: MarketType.FUTURES,
        OR: [{ makerUserId: userId }, { takerUserId: userId }],
        ...(opts.symbol ? { tickerSymbol: opts.symbol } : {}),
        ...(opts.endTime !== undefined ? { executedAt: { lte: new Date(opts.endTime) } } : {}),
      },
      orderBy: [{ executedAt: 'desc' }, { seq: 'desc' }],
      take: safeLimit,
    });

    return rows.flatMap((t) => {
      const entries: FuturesMyTrade[] = [];
      if (t.makerUserId === userId) entries.push(this.toMyTrade(t, true));
      if (t.takerUserId === userId) entries.push(this.toMyTrade(t, false));
      return entries;
    });
  }

  findIncome(
    userId: string,
    opts: { incomeType?: FuturesIncomeType; symbol?: string; limit: number },
  ) {
    const safeLimit = Math.min(Math.max(1, opts.limit), MAX_HISTORY_LIMIT);
    return this.prisma.futuresIncome.findMany({
      where: {
        userId,
        ...(opts.incomeType ? { incomeType: opts.incomeType } : {}),
        ...(opts.symbol ? { tickerSymbol: opts.symbol } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
    });
  }

  /**
   * 심볼별 레버리지 브라켓 — single-MMR이라 심볼당 단일 브라켓(no tier).
   * symbol 미지정 시 전 futures 심볼. 행/config 부재는 configOf가 throw.
   */
  async leverageBrackets(symbol?: string) {
    const symbols = symbol
      ? [symbol]
      : this.tickerStats.metaAll(MarketType.FUTURES).map((m) => m.symbol);
    return Promise.all(symbols.map((s) => this.bracketOf(s)));
  }

  private async bracketOf(symbol: string) {
    const config = await this.futuresConfig.configOf(symbol);
    return {
      symbol,
      brackets: [
        {
          bracket: 1,
          notionalCap: config.maxNotional.toFixed(8),
          notionalFloor: '0',
          maintMarginRatio: config.mmr.toFixed(8),
          maxLeverage: config.maxLeverage,
          liquidationFeeRate: config.liquidationFeeRate.toFixed(8),
        },
      ],
    };
  }

  /** 요청 유저의 수수료 요율(심볼 무관 동일 tier). bps → 8dp 소수 rate. */
  async commissionRate(userId: string, symbol: string) {
    const { makerBps, takerBps } = await this.users.feeRatesOf(userId);
    return {
      symbol,
      makerCommissionRate: this.bpsToRate(makerBps),
      takerCommissionRate: this.bpsToRate(takerBps),
    };
  }

  /**
   * 계정 집계 — FUTURES 지갑 잔고 + 포지션 마진수학.
   * UPNL/유지마진은 mark 형성된 포지션만 반영. availableBalance = 지갑잔고 − 포지션 초기마진.
   */
  async accountSummary(userId: string) {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId, marketType: MarketType.FUTURES },
      select: { balance: true },
    });
    const totalWalletBalance = wallets.reduce((acc, w) => acc.add(w.balance), ZERO);

    const positions = await this.prisma.position.findMany({
      where: { userId },
      orderBy: { tickerSymbol: 'asc' },
    });

    let totalUnrealizedProfit = ZERO;
    let totalMaintMargin = ZERO;
    let totalPositionInitialMargin = ZERO;
    for (const p of positions) {
      if (p.qty.isZero()) continue;
      totalPositionInitialMargin = totalPositionInitialMargin.add(p.isolatedMargin);
      const mark = this.markPrice.tryGetMark(p.tickerSymbol);
      if (mark === null) continue; // mark 미형성 포지션은 UPNL/MM 미반영
      const mmr = (await this.futuresConfig.configOf(p.tickerSymbol)).mmr;
      totalUnrealizedProfit = totalUnrealizedProfit.add(unrealizedPnl(mark, p.entryPrice, p.qty));
      totalMaintMargin = totalMaintMargin.add(maintenanceMargin(mmr, mark, p.qty));
    }

    const totalMarginBalance = totalWalletBalance.add(totalUnrealizedProfit);
    // 지급 가능액은 유저에게 불리한 방향(floor)으로 — 음수면 0
    const available = floor8(totalWalletBalance.sub(totalPositionInitialMargin));
    const availableBalance = available.gt(0) ? available : ZERO;

    return {
      totalWalletBalance: totalWalletBalance.toFixed(8),
      totalUnrealizedProfit: floor8(totalUnrealizedProfit).toFixed(8),
      totalMarginBalance: floor8(totalMarginBalance).toFixed(8),
      availableBalance: availableBalance.toFixed(8),
      totalMaintMargin: totalMaintMargin.toFixed(8),
      totalPositionInitialMargin: totalPositionInitialMargin.toFixed(8),
    };
  }

  // ---------- helpers ----------

  /** bps(정수) → 8dp 소수 rate. 10bps → '0.00100000'. */
  private bpsToRate(bps: number): string {
    return new Decimal(bps).div(BPS_DENOMINATOR).toFixed(8);
  }

  private toMyTrade(t: Trade, isMaker: boolean): FuturesMyTrade {
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
