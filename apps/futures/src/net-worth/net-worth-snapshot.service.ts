import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AssetType, MarketType, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { MarkPriceService } from '../mark-price/mark-price.service';
import { unrealizedPnl } from '../math/margin-math';

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

interface WalletRow {
  assetSymbol: string;
  marketType: MarketType;
  balance: Decimal;
  locked: Decimal;
}
interface PositionRow {
  tickerSymbol: string;
  entryPrice: Decimal;
  qty: Decimal;
}
interface BreakdownRow {
  market: MarketType;
  asset: string;
  qty: string;
  valueUsdt: string;
}
export interface UserValuation {
  totalUsdt: Decimal;
  spotUsdt: Decimal;
  futuresUsdt: Decimal;
  breakdown: BreakdownRow[];
}

/**
 * 일별 순자산 스냅샷 (Binance Estimated Balance 대응). futures 앱에서만 동작 — mark price가
 * 이 앱 메모리에만 있기 때문. 평가 = spot 보유(최근 spot 체결가) + futures 지갑 + 오픈 포지션 uPnL(mark).
 */
@Injectable()
export class NetWorthSnapshotService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NetWorthSnapshotService.name);

  constructor(
    private prisma: PrismaService,
    private markPrice: MarkPriceService,
  ) {}

  // 부팅 시 1회 시드 — 차트가 즉시 한 점을 갖도록(daily cron 전). best-effort.
  onApplicationBootstrap(): void {
    void this.snapshotAll().catch((e: unknown) =>
      this.logger.warn(`boot net-worth seed failed: ${String(e)}`),
    );
  }

  @Cron('0 0 * * *', { timeZone: 'UTC' })
  async snapshotAll(): Promise<void> {
    const day = utcDayStart(new Date());
    const wallets = await this.prisma.wallet.findMany();
    if (wallets.length === 0) return;

    const positions = await this.prisma.position.findMany({
      where: { qty: { not: ZERO } },
    });

    const prices = await this.buildPriceMap(wallets.map((w) => w.assetSymbol));

    const byUser = new Map<string, { wallets: WalletRow[]; positions: PositionRow[] }>();
    for (const w of wallets) {
      const g = byUser.get(w.userId) ?? { wallets: [], positions: [] };
      g.wallets.push(w);
      byUser.set(w.userId, g);
    }
    for (const p of positions) {
      const g = byUser.get(p.userId) ?? { wallets: [], positions: [] };
      g.positions.push(p);
      byUser.set(p.userId, g);
    }

    let written = 0;
    for (const [userId, g] of byUser) {
      try {
        const v = this.valueUser(g.wallets, g.positions, prices);
        const data = {
          totalUsdt: v.totalUsdt,
          spotUsdt: v.spotUsdt,
          futuresUsdt: v.futuresUsdt,
          breakdown: v.breakdown as unknown as Prisma.InputJsonValue,
        };
        await this.prisma.balanceSnapshot.upsert({
          where: { userId_day: { userId, day } },
          create: { userId, day, ...data },
          update: data,
        });
        written++;
      } catch (e) {
        this.logger.error(`net-worth snapshot failed for user ${userId}`, e as Error);
      }
    }
    this.logger.log(`net-worth snapshot ${day.toISOString().slice(0, 10)}: ${written} users`);
  }

  /** 한 유저 평가 — 순수 계산(가격맵 주입). spot/futures 분리 + per-asset breakdown. */
  valueUser(
    wallets: WalletRow[],
    positions: PositionRow[],
    prices: Map<string, Decimal>,
  ): UserValuation {
    let spotUsdt = ZERO;
    let futuresUsdt = ZERO;
    const breakdown: BreakdownRow[] = [];

    for (const w of wallets) {
      const qty = w.balance.add(w.locked);
      if (qty.isZero()) continue;
      const value = qty.mul(prices.get(w.assetSymbol) ?? ZERO);
      breakdown.push({
        market: w.marketType,
        asset: w.assetSymbol,
        qty: qty.toFixed(8),
        valueUsdt: value.toFixed(8),
      });
      if (w.marketType === MarketType.SPOT) spotUsdt = spotUsdt.add(value);
      else futuresUsdt = futuresUsdt.add(value);
    }

    // 오픈 포지션 미실현손익(mark) → futures에 가산. mark 미정의면 0 취급.
    for (const p of positions) {
      const mark = this.markPrice.tryGetMark(p.tickerSymbol);
      if (mark === null) continue;
      futuresUsdt = futuresUsdt.add(unrealizedPnl(mark, p.entryPrice, p.qty));
    }

    return {
      totalUsdt: spotUsdt.add(futuresUsdt),
      spotUsdt,
      futuresUsdt,
      breakdown,
    };
  }

  /** 자산→USDT 가격맵. 스테이블=1, 그 외 최근 spot {asset}USDT 체결가(없으면 미설정→0 취급). */
  private async buildPriceMap(assetSymbols: string[]): Promise<Map<string, Decimal>> {
    const distinct = [...new Set(assetSymbols)];
    const assets = await this.prisma.asset.findMany({
      where: { symbol: { in: distinct } },
      select: { symbol: true, type: true },
    });
    const stable = new Set(
      assets.filter((a) => a.type === AssetType.STABLECOIN).map((a) => a.symbol),
    );

    const prices = new Map<string, Decimal>();
    for (const sym of distinct) {
      if (stable.has(sym)) {
        prices.set(sym, ONE);
        continue;
      }
      const trade = await this.prisma.trade.findFirst({
        where: { tickerSymbol: `${sym}USDT`, tickerMarket: MarketType.SPOT },
        orderBy: { executedAt: 'desc' },
        select: { price: true },
      });
      if (trade) prices.set(sym, trade.price);
    }
    return prices;
  }
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
