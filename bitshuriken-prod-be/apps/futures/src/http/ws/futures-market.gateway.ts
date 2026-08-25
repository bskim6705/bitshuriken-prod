import { WebSocketGateway } from '@nestjs/websockets';
import { MarketType, OrderSide } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { WebSocket } from 'ws';
import { TickerStatsService, TradeEvent } from '@app/core-domain/ticker/ticker-stats.service';
import {
  BookTicker,
  OrderBookCacheService,
} from '@app/core-domain/orderbook/orderbook-cache.service';
import { KlineService } from '@app/core-domain/kline/kline.service';
import { KlineInterval, isKlineInterval } from '@app/core-domain/kline/intervals';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { fmtScaled } from '@app/shared/decimal';
import {
  ALL_TICKERS_STREAM,
  DEPTH_DIFF_SUFFIX,
  DepthDiffEvent,
  TRADE_SNAPSHOT_LIMIT,
  WsMarketGatewayBase,
} from '@app/shared/ws/market-gateway.base';
import { MarkPriceEvent, MarkPriceService } from '../../mark-price/mark-price.service';

type ParsedStream =
  | {
      kind:
        | 'depth'
        | 'depthDiff'
        | 'trade'
        | 'ticker'
        | 'markPrice'
        | 'miniTicker'
        | 'bookTicker'
        | 'aggTrade';
      symbol: string;
    }
  | { kind: 'kline'; symbol: string; interval: KlineInterval }
  | { kind: 'tickerArr' }
  | { kind: 'miniTickerArr' }
  | { kind: 'markPriceArr' };

interface MiniTicker {
  symbol: string;
  lastPrice: string;
  open: string | null;
  high: string | null;
  low: string | null;
  volume: string;
  quoteVolume: string;
}

/** 송출 전 누적 중인 동일가·동일 takerSide 체결 묶음. */
interface PendingAgg {
  price: Decimal;
  takerSide: OrderSide;
  qty: Decimal;
  firstTradeId: string;
  lastTradeId: string;
  firstTs: number;
  lastTs: number;
}

const MARKET: MarketType = 'FUTURES';
const ALL_MINI_TICKERS_STREAM = '!miniTicker@arr';
const ALL_MARK_PRICES_STREAM = '!markPrice@arr';

/** futures 마켓 데이터 게이트웨이 (공통은 WsMarketGatewayBase). */
@WebSocketGateway({ path: '/ws/fmarket' })
export class WsFuturesMarketGateway extends WsMarketGatewayBase {
  protected readonly market: MarketType = MARKET;

  private unsubscribeMark: (() => void) | null = null;

  // 1s 스로틀 — 직전 tick 이후 trade 발생 심볼
  private readonly dirtyMiniSymbols = new Set<string>();
  // kline 스트림별 마지막 push한 버킷 openTime (롤오버 감지)
  private readonly klineOpenTimes = new Map<string, number>();
  private klineTickInFlight = false;
  // 심볼별 최신 mark/index — !markPrice@arr 1s 배열 송출용
  private readonly latestMarks = new Map<string, MarkPriceEvent>();
  // 심볼별 누적 중인 aggTrade — price/side 전환 시 flush
  private readonly pendingAgg = new Map<string, PendingAgg>();

  constructor(
    protected readonly tickerStats: TickerStatsService,
    protected readonly obCache: OrderBookCacheService,
    private readonly markPrice: MarkPriceService,
    private readonly klineService: KlineService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  protected override onGatewayInit(): void {
    // mark는 1s tick마다 심볼별 1회 방출 — 추가 스로틀 불필요.
    this.unsubscribeMark = this.markPrice.onMark((event) => {
      this.latestMarks.set(event.symbol, event);
      this.fanoutMark(event).catch((err: unknown) => {
        this.logger.error(
          `markPrice fanout failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  protected override onGatewayDestroy(): void {
    this.unsubscribeMark?.();
  }

  protected onSecondTick(): void {
    this.broadcastTickerArr();
    this.broadcastMiniTickers();
    this.broadcastMarkPriceArr();
    this.flushPendingAgg();
    void this.tickKlines();
  }

  /** 파싱 가능 + 심볼이 FUTURES meta에 존재할 때만 유효. */
  protected parseAndValidate(stream: string): ParsedStream | null {
    const parsed = parseStream(stream);
    if (!parsed) return null;
    if ('symbol' in parsed && !this.tickerStats.metaOf(MARKET, parsed.symbol)) return null;
    return parsed;
  }

  /** 마지막 구독자가 빠진 kline 스트림의 롤오버 상태 정리. */
  protected override onStreamEmpty(stream: string): void {
    this.klineOpenTimes.delete(stream);
  }

  // ---- broadcast ----

  /** `@depth`는 full snapshot push, `@depth@100ms`는 U/u/pu diff 스트림 (spot과 동일). */
  onDepthDiff(market: MarketType, symbol: string, diff: DepthDiffEvent): void {
    if (market !== MARKET) return;
    const lower = symbol.toLowerCase();

    this.bufferDepthDiff(symbol, diff);

    const depthStream = `${lower}@depth`;
    if (this.clientsByStream.get(depthStream)?.size) {
      this.publish(depthStream, this.formattedDepth(symbol));
    }

    // best (price,qty) 실변경 시에만 push — lastUpdateId 변동만으로는 안 보냄
    const btStream = `${lower}@bookTicker`;
    if (this.clientsByStream.get(btStream)?.size) {
      const bt = this.obCache.bookTickerIfChanged(MARKET, symbol);
      if (bt) {
        const formatted = this.formatBookTicker(bt);
        if (formatted) this.publish(btStream, formatted);
      }
    }
  }

  protected override fanoutTrade(event: TradeEvent): void {
    if (event.market === MARKET) {
      this.dirtyMiniSymbols.add(event.symbol);
      this.fanoutAggTrade(event);
    }
    super.fanoutTrade(event);
  }

  private async fanoutMark(event: MarkPriceEvent): Promise<void> {
    const stream = `${event.symbol.toLowerCase()}@markPrice`;
    if (!this.clientsByStream.get(stream)?.size) return;
    const data = await this.markPricePayload(event.symbol, event.mark, event.index);
    if (data) this.publish(stream, data);
  }

  private broadcastMiniTickers(): void {
    for (const symbol of this.dirtyMiniSymbols) {
      const stream = `${symbol.toLowerCase()}@miniTicker`;
      if (!this.clientsByStream.get(stream)?.size) continue;
      const mini = this.miniTickerOf(symbol);
      if (mini) this.publish(stream, mini);
    }
    this.dirtyMiniSymbols.clear();

    const arrSubs = this.clientsByStream.get(ALL_MINI_TICKERS_STREAM);
    if (arrSubs?.size) {
      const arr = this.miniTickerArr();
      if (arr.length > 0) this.publish(ALL_MINI_TICKERS_STREAM, arr);
    }
  }

  private broadcastMarkPriceArr(): void {
    const subs = this.clientsByStream.get(ALL_MARK_PRICES_STREAM);
    if (!subs?.size) return;
    const arr = this.markPriceArr();
    if (arr.length > 0) this.publish(ALL_MARK_PRICES_STREAM, arr);
  }

  /** lastPrice 없는 심볼은 null (miniTicker에서 생략). */
  private miniTickerOf(symbol: string): MiniTicker | null {
    const snap = this.tickerStats.snapshotOne(MARKET, symbol);
    if (!snap || snap.lastPrice === null) return null;
    return {
      symbol: snap.symbol,
      lastPrice: snap.lastPrice,
      open: snap.open24h,
      high: snap.high24h,
      low: snap.low24h,
      volume: snap.volume24h,
      quoteVolume: snap.quoteVolume24h,
    };
  }

  private miniTickerArr(): MiniTicker[] {
    const result: MiniTicker[] = [];
    for (const snap of this.tickerStats.snapshotAll(MARKET)) {
      if (snap.lastPrice === null) continue;
      result.push({
        symbol: snap.symbol,
        lastPrice: snap.lastPrice,
        open: snap.open24h,
        high: snap.high24h,
        low: snap.low24h,
        volume: snap.volume24h,
        quoteVolume: snap.quoteVolume24h,
      });
    }
    return result;
  }

  // ---- aggTrade ----

  /**
   * 연속 동일가·동일 takerSide 체결을 한 메시지로 누적. price/side가 바뀌면
   * 누적분을 먼저 송출하고 새 그룹을 연다. 동일 그룹이 이어지면 push 없이 합산만.
   */
  private fanoutAggTrade(event: TradeEvent): void {
    const stream = `${event.symbol.toLowerCase()}@aggTrade`;
    const pending = this.pendingAgg.get(event.symbol);
    if (pending && pending.price.eq(event.price) && pending.takerSide === event.takerSide) {
      pending.qty = pending.qty.add(event.qty);
      pending.lastTradeId = event.tradeId;
      pending.lastTs = event.ts;
      return;
    }
    if (pending && this.clientsByStream.get(stream)?.size) {
      this.publish(stream, this.aggTradePayload(event.symbol, pending));
    }
    this.pendingAgg.set(event.symbol, {
      price: event.price,
      takerSide: event.takerSide,
      qty: event.qty,
      firstTradeId: event.tradeId,
      lastTradeId: event.tradeId,
      firstTs: event.ts,
      lastTs: event.ts,
    });
  }

  /** 누적분을 즉시 송출하고 그룹을 닫는다 — 다음 체결이 와야 flush되는 지연 방지. */
  private flushPendingAgg(): void {
    for (const [symbol, pending] of this.pendingAgg) {
      const stream = `${symbol.toLowerCase()}@aggTrade`;
      if (this.clientsByStream.get(stream)?.size) {
        this.publish(stream, this.aggTradePayload(symbol, pending));
      }
    }
    this.pendingAgg.clear();
  }

  private aggTradePayload(symbol: string, agg: PendingAgg): Record<string, unknown> | null {
    const meta = this.tickerStats.metaOf(MARKET, symbol);
    if (!meta) return null;
    return {
      aggId: agg.firstTradeId,
      symbol,
      price: agg.price.toFixed(meta.pricePrecision),
      qty: agg.qty.toFixed(meta.qtyPrecision),
      firstTradeId: agg.firstTradeId,
      lastTradeId: agg.lastTradeId,
      side: agg.takerSide,
      isBuyerMaker: agg.takerSide === 'SELL',
      ts: agg.lastTs,
    };
  }

  private markPriceArr(): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const event of this.latestMarks.values()) {
      const meta = this.tickerStats.metaOf(MARKET, event.symbol);
      if (!meta) continue;
      result.push({
        symbol: event.symbol,
        markPrice: event.mark.toFixed(meta.pricePrecision),
        indexPrice: event.index.toFixed(meta.pricePrecision),
        nextFundingTime: this.markPrice.nextFundingTime().getTime(),
      });
    }
    return result;
  }

  // ---- kline 1s timer ----

  private async tickKlines(): Promise<void> {
    if (this.klineTickInFlight) return; // SQL 지연 시 tick 중첩 방지
    this.klineTickInFlight = true;
    try {
      for (const [stream, subs] of this.clientsByStream) {
        if (subs.size === 0) continue;
        const parsed = parseStream(stream);
        if (!parsed || parsed.kind !== 'kline') continue;
        await this.pushKline(stream, parsed.symbol, parsed.interval);
      }
    } catch (err) {
      this.logger.error(`kline tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.klineTickInFlight = false;
    }
  }

  /** 현재 버킷 push. 롤오버 감지 시 직전 버킷(isFinal=true)을 1회 먼저 push. */
  private async pushKline(stream: string, symbol: string, interval: KlineInterval): Promise<void> {
    const klines = await this.klineService.getKlines(MARKET, symbol, interval, 2);
    if (!klines || klines.length === 0) return;
    const current = klines[klines.length - 1];

    const prevOpen = this.klineOpenTimes.get(stream);
    if (prevOpen !== undefined && current.openTime > prevOpen) {
      const finalCandle = klines.find((k) => k.openTime === prevOpen);
      if (finalCandle) this.publish(stream, finalCandle);
    }
    this.klineOpenTimes.set(stream, current.openTime);
    this.publish(stream, current);
  }

  // ---- snapshot on subscribe ----

  protected async sendSnapshot(client: WebSocket, stream: string): Promise<void> {
    const parsed = parseStream(stream);
    if (!parsed) return;

    if (parsed.kind === 'depth') {
      this.send(client, { stream, data: this.formattedDepth(parsed.symbol) });
    } else if (parsed.kind === 'depthDiff') {
      // diff 스트림은 스냅샷 없음 — 클라이언트가 REST /depth(lastUpdateId)로 동기화
    } else if (parsed.kind === 'trade') {
      const meta = this.tickerStats.metaOf(MARKET, parsed.symbol);
      if (!meta) return;
      // domain/trade는 spot 소유 — Prisma 직접 조회
      const trades = await this.prisma.trade.findMany({
        where: { tickerSymbol: parsed.symbol, tickerMarket: MARKET },
        orderBy: { createdAt: 'desc' },
        take: TRADE_SNAPSHOT_LIMIT,
        select: {
          id: true,
          tickerSymbol: true,
          price: true,
          qty: true,
          takerSide: true,
          createdAt: true,
        },
      });
      const formatted = trades.map((t) => ({
        id: t.id,
        symbol: t.tickerSymbol,
        price: t.price.toFixed(meta.pricePrecision),
        qty: t.qty.toFixed(meta.qtyPrecision),
        side: t.takerSide,
        ts: t.createdAt.getTime(),
      }));
      this.send(client, { stream, data: formatted });
    } else if (parsed.kind === 'ticker') {
      const snap = this.tickerStats.snapshotOne(MARKET, parsed.symbol);
      if (snap) this.send(client, { stream, data: snap });
    } else if (parsed.kind === 'tickerArr') {
      this.send(client, { stream, data: this.tickerStats.snapshotAll(MARKET) });
    } else if (parsed.kind === 'miniTicker') {
      const mini = this.miniTickerOf(parsed.symbol);
      if (mini) this.send(client, { stream, data: mini });
    } else if (parsed.kind === 'miniTickerArr') {
      this.send(client, { stream, data: this.miniTickerArr() });
    } else if (parsed.kind === 'bookTicker') {
      const bt = this.obCache.getBookTicker(MARKET, parsed.symbol);
      if (!bt) return;
      const formatted = this.formatBookTicker(bt);
      if (formatted) this.send(client, { stream, data: formatted });
    } else if (parsed.kind === 'kline') {
      const candle = await this.klineService.currentCandle(MARKET, parsed.symbol, parsed.interval);
      if (candle) this.send(client, { stream, data: candle });
    } else if (parsed.kind === 'markPrice') {
      const mark = this.markPrice.tryGetMark(parsed.symbol);
      const index = this.markPrice.getIndex(parsed.symbol);
      if (mark === null || index === null) return; // index 미형성 — 첫 tick부터 push
      const data = await this.markPricePayload(parsed.symbol, mark, index);
      if (data) this.send(client, { stream, data });
    } else if (parsed.kind === 'markPriceArr') {
      this.send(client, { stream, data: this.markPriceArr() });
    } else if (parsed.kind === 'aggTrade') {
      const meta = this.tickerStats.metaOf(MARKET, parsed.symbol);
      if (!meta) return;
      const agg = await this.recentAggTrades(parsed.symbol, meta.pricePrecision, meta.qtyPrecision);
      this.send(client, { stream, data: agg });
    }
  }

  /** 구독 직후 시드 — spot REST aggTrades와 동일 그룹핑 (takerOrderId, price). domain/trade는 spot 소유라 Prisma 직접 조회. */
  private async recentAggTrades(
    symbol: string,
    pricePrecision: number,
    qtyPrecision: number,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.$queryRaw<
      {
        first_trade_id: string;
        last_trade_id: string;
        price: Decimal;
        qty: Decimal;
        ts: Date;
        is_buyer_maker: boolean;
      }[]
    >`
      SELECT (array_agg(t.id ORDER BY t.seq ASC))[1]  AS first_trade_id,
             (array_agg(t.id ORDER BY t.seq DESC))[1] AS last_trade_id,
             t.price                                   AS price,
             sum(t.qty)                                AS qty,
             max(t."executedAt")                       AS ts,
             bool_or(t."takerSide" = 'SELL')           AS is_buyer_maker
      FROM "Trade" t
      WHERE t."tickerSymbol" = ${symbol}
        AND t."tickerMarket" = ${MARKET}::"MarketType"
      GROUP BY t."takerOrderId", t.price
      ORDER BY max(t.seq) DESC
      LIMIT ${TRADE_SNAPSHOT_LIMIT}
    `;
    return rows.map((r) => ({
      aggId: r.first_trade_id,
      symbol,
      price: r.price.toFixed(pricePrecision),
      qty: r.qty.toFixed(qtyPrecision),
      firstTradeId: r.first_trade_id,
      lastTradeId: r.last_trade_id,
      side: r.is_buyer_maker ? OrderSide.SELL : OrderSide.BUY,
      isBuyerMaker: r.is_buyer_maker,
      ts: r.ts.getTime(),
    }));
  }

  private formatBookTicker(bt: BookTicker): Record<string, unknown> | null {
    const meta = this.tickerStats.metaOf(MARKET, bt.symbol);
    if (!meta) return null;
    return {
      symbol: bt.symbol,
      bidPrice: fmtScaled(bt.bidPrice, meta.pricePrecision),
      bidQty: fmtScaled(bt.bidQty, meta.qtyPrecision),
      askPrice: fmtScaled(bt.askPrice, meta.pricePrecision),
      askQty: fmtScaled(bt.askQty, meta.qtyPrecision),
      lastUpdateId: bt.lastUpdateId,
    };
  }

  private async markPricePayload(
    symbol: string,
    mark: Decimal,
    index: Decimal,
  ): Promise<Record<string, unknown> | null> {
    const meta = this.tickerStats.metaOf(MARKET, symbol);
    if (!meta) return null;
    const last = await this.markPrice.lastFundingRate(symbol);
    return {
      symbol,
      markPrice: mark.toFixed(meta.pricePrecision),
      indexPrice: index.toFixed(meta.pricePrecision),
      lastFundingRate: last?.rate.toFixed(8) ?? null,
      nextFundingTime: this.markPrice.nextFundingTime().getTime(),
    };
  }
}

function parseStream(stream: string): ParsedStream | null {
  if (stream === ALL_TICKERS_STREAM) return { kind: 'tickerArr' };
  if (stream === ALL_MINI_TICKERS_STREAM) return { kind: 'miniTickerArr' };
  if (stream === ALL_MARK_PRICES_STREAM) return { kind: 'markPriceArr' };
  const at = stream.indexOf('@');
  if (at < 1) return null;
  const rawSym = stream.slice(0, at);
  // publish는 lowercase 심볼 스트림으로만 발행 — 대소문자 불일치 구독은 push를 영영 못 받는다
  if (rawSym !== rawSym.toLowerCase()) return null;
  const sym = rawSym.toUpperCase();
  const kind = stream.slice(at + 1);
  if (kind === DEPTH_DIFF_SUFFIX) return { kind: 'depthDiff', symbol: sym };
  if (kind.startsWith('kline_')) {
    const interval = kind.slice('kline_'.length);
    if (!isKlineInterval(interval)) return null;
    return { kind: 'kline', symbol: sym, interval };
  }
  if (
    kind === 'depth' ||
    kind === 'trade' ||
    kind === 'ticker' ||
    kind === 'markPrice' ||
    kind === 'miniTicker' ||
    kind === 'bookTicker' ||
    kind === 'aggTrade'
  ) {
    return { kind, symbol: sym };
  }
  return null;
}
