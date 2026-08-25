import { WebSocketGateway } from '@nestjs/websockets';
import { MarketType, OrderSide } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { WebSocket } from 'ws';
import { TickerStatsService, TradeEvent } from '@app/core-domain/ticker/ticker-stats.service';
import { TradeService } from '../../domain/trade/trade.service';
import {
  BookTicker,
  OrderBookCacheService,
} from '@app/core-domain/orderbook/orderbook-cache.service';
import { KlineService } from '@app/core-domain/kline/kline.service';
import { KlineInterval, isKlineInterval } from '@app/core-domain/kline/intervals';
import { fmtScaled } from '@app/shared/decimal';
import {
  ALL_TICKERS_STREAM,
  DEPTH_DIFF_SUFFIX,
  DepthDiffEvent,
  TRADE_SNAPSHOT_LIMIT,
  WsMarketGatewayBase,
} from '@app/shared/ws/market-gateway.base';

type ParsedStream =
  | {
      kind: 'depth' | 'depthDiff' | 'trade' | 'aggTrade' | 'ticker' | 'miniTicker' | 'bookTicker';
      symbol: string;
    }
  | { kind: 'kline'; symbol: string; interval: KlineInterval }
  | { kind: 'tickerArr' }
  | { kind: 'miniTickerArr' };

interface MiniTicker {
  symbol: string;
  lastPrice: string;
  open: string | null;
  high: string | null;
  low: string | null;
  volume: string;
  quoteVolume: string;
}

const MARKET: MarketType = 'SPOT';
const ALL_MINI_TICKERS_STREAM = '!miniTicker@arr';

/** 라이브 연속 집계 — 동일가·동일 taker side가 이어지는 동안 누적되는 진행 중 aggTrade. */
interface PendingAgg {
  aggId: string;
  symbol: string;
  price: Decimal;
  qty: Decimal;
  firstTradeId: string;
  lastTradeId: string;
  takerSide: OrderSide;
  ts: number;
}

@WebSocketGateway({ path: '/ws/market' })
export class WsMarketGateway extends WsMarketGatewayBase {
  protected readonly market: MarketType = MARKET;

  // 1s 스로틀 — 직전 tick 이후 trade 발생 심볼
  private readonly dirtyMiniSymbols = new Set<string>();
  // 심볼별 진행 중 aggTrade run — 가격/사이드 전환 또는 1s tick에서 flush
  private readonly pendingAggBySymbol = new Map<string, PendingAgg>();
  // kline 스트림별 마지막 push한 버킷 openTime (롤오버 감지)
  private readonly klineOpenTimes = new Map<string, number>();
  private klineTickInFlight = false;

  constructor(
    protected readonly tickerStats: TickerStatsService,
    private readonly tradeService: TradeService,
    protected readonly obCache: OrderBookCacheService,
    private readonly klineService: KlineService,
  ) {
    super();
  }

  protected onSecondTick(): void {
    this.broadcastTickerArr();
    this.broadcastMiniTickers();
    this.flushPendingAggs();
    void this.tickKlines();
  }

  /** 파싱 가능 + 심볼이 SPOT meta에 존재할 때만 유효. */
  protected parseAndValidate(stream: string): ParsedStream | null {
    const parsed = parseStream(stream);
    if (!parsed) return null;
    if ('symbol' in parsed && !this.tickerStats.metaOf(MARKET, parsed.symbol)) return null;
    return parsed;
  }

  /** 마지막 구독자가 빠진 스트림의 잔여 상태 정리(kline 롤오버 / aggTrade run). */
  protected override onStreamEmpty(stream: string): void {
    this.klineOpenTimes.delete(stream);
    const parsed = parseStream(stream);
    if (parsed && parsed.kind === 'aggTrade') {
      this.pendingAggBySymbol.delete(parsed.symbol);
    }
  }

  // ---- broadcast ----

  /**
   * `@depth`는 full snapshot push(FE용 단순 경로), `@depth@100ms`는 U/u/pu diff 스트림
   * (알고 클라이언트용 — 베이스의 100ms 병합 버퍼가 송출).
   */
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
      this.accumulateAggTrade(event);
    }
    super.fanoutTrade(event);
  }

  // ---- aggTrade live aggregation ----

  /**
   * 연속 동일가·동일 side trade를 하나의 aggTrade run으로 누적.
   * 가격 또는 side가 바뀌면 직전 run을 즉시 flush 후 새 run 시작.
   */
  private accumulateAggTrade(event: TradeEvent): void {
    const pending = this.pendingAggBySymbol.get(event.symbol);
    if (pending && pending.takerSide === event.takerSide && pending.price.eq(event.price)) {
      pending.qty = pending.qty.add(event.qty);
      pending.lastTradeId = event.tradeId;
      pending.ts = event.ts;
      return;
    }
    if (pending) this.publishAggTrade(pending);
    this.pendingAggBySymbol.set(event.symbol, {
      aggId: event.tradeId,
      symbol: event.symbol,
      price: event.price,
      qty: event.qty,
      firstTradeId: event.tradeId,
      lastTradeId: event.tradeId,
      takerSide: event.takerSide,
      ts: event.ts,
    });
  }

  /** 진행 중 run을 1s tick마다 flush — 한 run이 영영 묶여 push가 지연되는 것 방지. */
  private flushPendingAggs(): void {
    if (this.pendingAggBySymbol.size === 0) return;
    for (const pending of this.pendingAggBySymbol.values()) {
      this.publishAggTrade(pending);
    }
    this.pendingAggBySymbol.clear();
  }

  private publishAggTrade(agg: PendingAgg): void {
    const stream = `${agg.symbol.toLowerCase()}@aggTrade`;
    if (!this.clientsByStream.get(stream)?.size) return;
    const meta = this.tickerStats.metaOf(MARKET, agg.symbol);
    if (!meta) return;
    this.publish(stream, this.formatAggTrade(agg, meta.pricePrecision, meta.qtyPrecision));
  }

  /** REST aggTrades 스냅샷과 동일한 named shape. isBuyerMaker: taker SELL이면 buyer가 maker. */
  private formatAggTrade(
    agg: {
      aggId: string;
      symbol: string;
      price: Decimal;
      qty: Decimal;
      firstTradeId: string;
      lastTradeId: string;
      ts: number;
      takerSide: OrderSide;
    },
    pricePrecision: number,
    qtyPrecision: number,
  ): Record<string, unknown> {
    return {
      aggId: agg.aggId,
      symbol: agg.symbol,
      price: agg.price.toFixed(pricePrecision),
      qty: agg.qty.toFixed(qtyPrecision),
      firstTradeId: agg.firstTradeId,
      lastTradeId: agg.lastTradeId,
      side: agg.takerSide,
      isBuyerMaker: agg.takerSide === 'SELL',
      ts: agg.ts,
    };
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
      const trades = await this.tradeService.findRecent(
        parsed.symbol,
        MARKET,
        TRADE_SNAPSHOT_LIMIT,
      );
      const formatted = trades.map((t) => ({
        id: t.id,
        symbol: t.tickerSymbol,
        price: t.price.toFixed(meta.pricePrecision),
        qty: t.qty.toFixed(meta.qtyPrecision),
        side: t.takerSide,
        ts: t.createdAt.getTime(),
      }));
      this.send(client, { stream, data: formatted });
    } else if (parsed.kind === 'aggTrade') {
      const meta = this.tickerStats.metaOf(MARKET, parsed.symbol);
      if (!meta) return;
      const aggs = await this.tradeService.aggTrades(parsed.symbol, MARKET, TRADE_SNAPSHOT_LIMIT);
      const formatted = aggs.map((a) => ({
        aggId: a.aggId,
        symbol: parsed.symbol,
        price: a.price.toFixed(meta.pricePrecision),
        qty: a.qty.toFixed(meta.qtyPrecision),
        firstTradeId: a.firstTradeId,
        lastTradeId: a.lastTradeId,
        // REST 집계는 takerSide를 직접 노출하지 않음 — isBuyerMaker(taker SELL)에서 역산
        side: a.isBuyerMaker ? 'SELL' : 'BUY',
        isBuyerMaker: a.isBuyerMaker,
        ts: a.ts,
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
    }
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
}

function parseStream(stream: string): ParsedStream | null {
  if (stream === ALL_TICKERS_STREAM) return { kind: 'tickerArr' };
  if (stream === ALL_MINI_TICKERS_STREAM) return { kind: 'miniTickerArr' };
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
    kind === 'aggTrade' ||
    kind === 'ticker' ||
    kind === 'miniTicker' ||
    kind === 'bookTicker'
  ) {
    return { kind, symbol: sym };
  }
  return null;
}
