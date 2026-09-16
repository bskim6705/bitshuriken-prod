import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { EventEmitter } from 'node:events';
import { FundingRate, MarketType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { Consumer, Kafka } from 'kafkajs';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { Op, outboundTopic } from '@app/infra/messaging/topics';
import { parseTradeMsg } from '@app/infra/messaging/match-message.parser';
import { OrderBookCacheService } from '@app/core-domain/orderbook/orderbook-cache.service';
import { SCALE, floor8 } from '@app/shared/decimal';
import { FuturesConfigService } from '../config/futures-config.service';

const INDEX_CONSUMER_GROUP = 'bitshuriken-futures-index';
const EMA_TAU_MS = 30_000;

// 펀딩 주기 8h (UTC 00/08/16) — 코드 상수
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
// premium 1분 샘플 × 8h = 480
const PREMIUM_RING_MAX = 480;

export interface MarkPriceEvent {
  symbol: string;
  mark: Decimal;
  index: Decimal;
}

interface SymbolState {
  index: Decimal | null;
  indexTs: number | null; // 마지막 spot TR ts (ms)
  premiumEma: Decimal | null;
  premiumTs: number | null; // 마지막 premium EMA 갱신 시각 (ms)
  mark: Decimal | null;
}

/**
 * mark = index + clamp(EMA30s(futures mid − index), ±index×markClampPct).
 * index = 자체 spot 체결가의 시간가중 EMA30s — 별도 consumer group으로 match.spot.out read-only 구독.
 * index 부재(부팅 후 spot 체결 0건)면 mark 미정의 → getMark() throw.
 */
@Injectable()
export class MarkPriceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarkPriceService.name);
  private readonly state = new Map<string, SymbolState>();
  private readonly premiumRing = new Map<string, Decimal[]>();
  private readonly emitter = new EventEmitter();
  private readonly consumer: Consumer;
  private ticking = false;

  constructor(
    private prisma: PrismaService,
    private orderBookCache: OrderBookCacheService,
    private futuresConfig: FuturesConfigService,
  ) {
    const broker = process.env.KAFKA_BROKER;
    if (!broker) throw new Error('KAFKA_BROKER is required');
    const kafka = new Kafka({ clientId: INDEX_CONSUMER_GROUP, brokers: [broker] });
    this.consumer = kafka.consumer({ groupId: INDEX_CONSUMER_GROUP });
  }

  async onModuleInit(): Promise<void> {
    const tickers = await this.prisma.ticker.findMany({
      where: { marketType: MarketType.FUTURES },
      select: { symbol: true },
    });
    for (const t of tickers) {
      this.state.set(t.symbol, {
        index: null,
        indexTs: null,
        premiumEma: null,
        premiumTs: null,
        mark: null,
      });
      this.premiumRing.set(t.symbol, []);
    }
    this.logger.log(
      `futures symbols loaded: ${tickers.map((t) => t.symbol).join(', ') || '(none)'}`,
    );

    await this.consumer.connect();
    await this.consumer.subscribe({ topic: outboundTopic(MarketType.SPOT) });
    await this.consumer.run({
      // eslint-disable-next-line @typescript-eslint/require-await
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        try {
          const payload = JSON.parse(message.value.toString()) as { op?: string };
          if (payload.op !== Op.TRADE) return;
          const trade = parseTradeMsg(payload);
          this.updateIndex(trade.symbol, trade.price, trade.ts);
        } catch (e) {
          // poison message로 index 파이프라인이 멈추지 않도록 기록 후 skip
          this.logger.error('failed to process spot TR for index', e as Error);
        }
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
  }

  /** 시간가중 EMA30s: alpha = 1 − exp(−dt/τ). 가격 산술은 Decimal, floor 8dp. */
  private updateIndex(symbol: string, price: Decimal, ts: number): void {
    const s = this.state.get(symbol);
    if (!s) return; // futures 미상장 spot 심볼
    if (s.index === null || s.indexTs === null) {
      s.index = floor8(price);
    } else {
      const dt = Math.max(0, ts - s.indexTs);
      const alpha = new Decimal(1 - Math.exp(-dt / EMA_TAU_MS));
      s.index = floor8(s.index.add(alpha.mul(price.sub(s.index))));
    }
    s.indexTs = ts;
  }

  @Interval(1000)
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.computeMarks();
    } catch (e) {
      this.logger.error('mark price tick failed', e as Error);
    } finally {
      this.ticking = false;
    }
  }

  private async computeMarks(): Promise<void> {
    const now = Date.now();
    for (const [symbol, s] of this.state) {
      if (s.index === null) continue; // index 부재 → mark 미정의

      const book = this.orderBookCache.getBookTicker(MarketType.FUTURES, symbol);
      if (!book) {
        s.mark = s.index; // mid 부재 → mark = index
      } else {
        const mid = floor8(new Decimal(book.bidPrice).add(book.askPrice).div(2).div(SCALE));
        const premium = mid.sub(s.index);
        if (s.premiumEma === null || s.premiumTs === null) {
          s.premiumEma = floor8(premium);
        } else {
          const dt = Math.max(0, now - s.premiumTs);
          const alpha = new Decimal(1 - Math.exp(-dt / EMA_TAU_MS));
          s.premiumEma = floor8(s.premiumEma.add(alpha.mul(premium.sub(s.premiumEma))));
        }
        s.premiumTs = now;

        const config = await this.futuresConfig.configOf(symbol);
        const bound = floor8(s.index.mul(config.markClampPct));
        const clamped = Decimal.min(Decimal.max(s.premiumEma, bound.neg()), bound);
        s.mark = floor8(s.index.add(clamped));
      }

      const event: MarkPriceEvent = { symbol, mark: s.mark, index: s.index };
      this.emitter.emit('futures.mark', event);
    }
  }

  /** 펀딩 premium 1분 샘플 P = (mark − index)/index. mark 미정의면 skip (부분 윈도우 허용). */
  @Cron('0 * * * * *')
  samplePremium(): void {
    for (const [symbol, s] of this.state) {
      if (s.mark === null || s.index === null) continue;
      if (s.index.lte(0)) {
        this.logger.error(`index <= 0 for ${symbol}, premium sample skipped`);
        continue;
      }
      const ring = this.premiumRing.get(symbol);
      if (!ring) continue;
      ring.push(floor8(s.mark.sub(s.index).div(s.index)));
      if (ring.length > PREMIUM_RING_MAX) ring.shift();
    }
  }

  /** 주문 접수/청산/펀딩용 — mark 미정의면 throw (fail loudly). */
  getMark(symbol: string): Decimal {
    const mark = this.tryGetMark(symbol);
    if (mark === null) {
      throw new Error(
        `mark price unavailable for ${symbol}: spot index not established (no spot trade observed yet)`,
      );
    }
    return mark;
  }

  /** 조회성 API용 — 미정의면 null. */
  tryGetMark(symbol: string): Decimal | null {
    return this.state.get(symbol)?.mark ?? null;
  }

  getIndex(symbol: string): Decimal | null {
    return this.state.get(symbol)?.index ?? null;
  }

  /** 1s tick마다 mark/index 발행. 반환값은 구독 해제 함수. */
  onMark(listener: (event: MarkPriceEvent) => void): () => void {
    this.emitter.on('futures.mark', listener);
    return () => this.emitter.off('futures.mark', listener);
  }

  /** 펀딩 정산용 — 적립된 premium 샘플을 반환하고 비운다. */
  drainPremiumSamples(symbol: string): Decimal[] {
    const ring = this.premiumRing.get(symbol);
    if (!ring) throw new Error(`unknown futures symbol: ${symbol}`);
    this.premiumRing.set(symbol, []);
    return ring;
  }

  nextFundingTime(): Date {
    return new Date((Math.floor(Date.now() / FUNDING_INTERVAL_MS) + 1) * FUNDING_INTERVAL_MS);
  }

  lastFundingRate(symbol: string): Promise<FundingRate | null> {
    return this.prisma.fundingRate.findFirst({
      where: { tickerSymbol: symbol },
      orderBy: { fundingTime: 'desc' },
    });
  }
}
