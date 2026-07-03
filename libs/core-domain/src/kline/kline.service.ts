import { Injectable } from '@nestjs/common';
import { MarketType, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService } from '../ticker/ticker-stats.service';
import {
  INTERVAL_MS,
  KlineInterval,
  WEEK_OFFSET_MS,
  bucketStartMs,
  nextBucketStartMs,
  windowStartMs,
} from './intervals';

const MAX_KLINE_LIMIT = 1000;

export interface Kline {
  symbol: string;
  interval: KlineInterval;
  openTime: number;
  closeTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quoteVolume: string;
  tradeCount: number;
  isFinal: boolean;
}

interface BucketRow {
  bucket: bigint;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
  quote_volume: Decimal;
  trade_count: number;
}

/**
 * Kline 계산 — Trade 테이블 SQL 단일 소스 (in-memory 캔들 없음).
 * 버킷 기준은 executedAt, OHLC 동률은 seq로 tie-break.
 */
@Injectable()
export class KlineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickerStats: TickerStatsService,
  ) {}

  /**
   * 최근 limit개 버킷 (현재 미완결 버킷 포함). 빈 버킷은 직전 close로 fill-forward,
   * 최초 체결 이전 버킷은 trim. 미상장 ticker면 null.
   */
  async getKlines(
    market: MarketType,
    symbol: string,
    interval: KlineInterval,
    limit: number,
    endTime?: number,
  ): Promise<Kline[] | null> {
    const meta = this.tickerStats.metaOf(market, symbol);
    if (!meta) return null;

    const safeLimit = Math.min(Math.max(1, limit), MAX_KLINE_LIMIT);
    const now = Date.now();
    // 미래 endTime은 now로 클램프 — 미래 빈 버킷 생성 방지
    const end = Math.min(endTime ?? now, now);
    // 윈도 [end - limit*w, end), 첫 그리드 버킷은 버킷 경계로 내림
    const gridStart = bucketStartMs(interval, windowStartMs(interval, end, safeLimit));
    if (gridStart >= end) return [];
    // 집계 상한은 마지막 emit 버킷의 close — end가 버킷 중간이어도 최종 캔들이 잘리지 않게
    const queryEnd = nextBucketStartMs(interval, bucketStartMs(interval, end - 1));

    const bucket = this.bucketSql(interval);
    const [rows, anchorRows] = await Promise.all([
      this.prisma.$queryRaw<BucketRow[]>(Prisma.sql`
        SELECT ${bucket} AS bucket,
               (array_agg(t.price ORDER BY t.seq ASC))[1]  AS open,
               max(t.price)                                 AS high,
               min(t.price)                                 AS low,
               (array_agg(t.price ORDER BY t.seq DESC))[1] AS close,
               sum(t.qty)                                   AS volume,
               sum(t.price * t.qty)                         AS quote_volume,
               count(*)::int                                AS trade_count
        FROM "Trade" t
        WHERE t."tickerSymbol" = ${symbol}
          AND t."tickerMarket" = ${market}::"MarketType"
          AND t."executedAt" >= ${new Date(gridStart)}
          AND t."executedAt" < ${new Date(queryEnd)}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      // fill-forward anchor: 윈도 시작 직전 마지막 체결가
      this.prisma.$queryRaw<{ price: Decimal }[]>(Prisma.sql`
        SELECT t.price
        FROM "Trade" t
        WHERE t."tickerSymbol" = ${symbol}
          AND t."tickerMarket" = ${market}::"MarketType"
          AND t."executedAt" < ${new Date(gridStart)}
        ORDER BY t."executedAt" DESC, t.seq DESC
        LIMIT 1
      `),
    ]);

    const byBucket = new Map<number, BucketRow>();
    for (const row of rows) byBucket.set(Number(row.bucket), row);

    let prevClose: Decimal | null = anchorRows[0]?.price ?? null;
    const klines: Kline[] = [];

    for (let b = gridStart; b < end; b = nextBucketStartMs(interval, b)) {
      const row = byBucket.get(b);
      if (!row && prevClose === null) continue; // 심볼 최초 체결 이전 버킷 trim
      const next = nextBucketStartMs(interval, b);
      const isFinal = next <= now;
      if (row) {
        klines.push({
          symbol,
          interval,
          openTime: b,
          closeTime: next - 1,
          open: row.open.toFixed(meta.pricePrecision),
          high: row.high.toFixed(meta.pricePrecision),
          low: row.low.toFixed(meta.pricePrecision),
          close: row.close.toFixed(meta.pricePrecision),
          volume: row.volume.toFixed(meta.qtyPrecision),
          quoteVolume: row.quote_volume.toFixed(meta.pricePrecision),
          tradeCount: row.trade_count,
          isFinal,
        });
        prevClose = row.close;
      } else {
        const close = prevClose.toFixed(meta.pricePrecision);
        klines.push({
          symbol,
          interval,
          openTime: b,
          closeTime: next - 1,
          open: close,
          high: close,
          low: close,
          close,
          volume: new Decimal(0).toFixed(meta.qtyPrecision),
          quoteVolume: new Decimal(0).toFixed(meta.pricePrecision),
          tradeCount: 0,
          isFinal,
        });
      }
    }

    return klines.slice(-safeLimit);
  }

  /** 현재(미완결) 버킷 1개. 체결 이력이 전무하면 null. */
  async currentCandle(
    market: MarketType,
    symbol: string,
    interval: KlineInterval,
  ): Promise<Kline | null> {
    const klines = await this.getKlines(market, symbol, interval, 1);
    if (!klines || klines.length === 0) return null;
    return klines[klines.length - 1];
  }

  /** 버킷 openTime SQL — 고정폭은 정수 floor, 1w는 월요일 오프셋, 1M은 date_trunc. */
  private bucketSql(interval: KlineInterval): Prisma.Sql {
    if (interval === '1M') {
      return Prisma.sql`(round(extract(epoch FROM date_trunc('month', t."executedAt")) * 1000))::bigint`;
    }
    const w = INTERVAL_MS[interval];
    const off = interval === '1w' ? WEEK_OFFSET_MS : 0;
    return Prisma.sql`((((round(extract(epoch FROM t."executedAt") * 1000))::bigint - ${off}::bigint) / ${w}::bigint) * ${w}::bigint + ${off}::bigint)`;
  }
}
