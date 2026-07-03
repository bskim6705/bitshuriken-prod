import { HttpStatus, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { MarketType, OrderSide, TickerStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const AVG_PRICE_WINDOW_MS = 5 * 60 * 1000;

interface TradeEntry {
  price: Decimal;
  qty: Decimal;
  createdAt: number; // epoch ms (executedAt)
}

interface State {
  trades: TradeEntry[];
  lastPrice: Decimal | null;
  high24h: Decimal | null;
  low24h: Decimal | null;
  firstPrice24h: Decimal | null;
  tradeCount: number;
  volume: Decimal;
  quoteVolume: Decimal;
}

export interface TickerMeta {
  symbol: string;
  marketType: MarketType;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  qtyPrecision: number;
  minNotional: Decimal;
}

export interface Ticker24h {
  symbol: string;
  marketType: MarketType;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  qtyPrecision: number;
  lastPrice: string | null;
  open24h: string | null;
  priceChange24h: string | null;
  priceChangePct24h: string | null;
  high24h: string | null;
  low24h: string | null;
  volume24h: string;
  quoteVolume24h: string;
  tradeCount24h: number;
}

export interface TradeEvent {
  market: MarketType;
  symbol: string;
  tradeId: string;
  price: Decimal;
  qty: Decimal;
  takerSide: OrderSide;
  ts: number;
}

function keyOf(market: MarketType, symbol: string): string {
  return `${market}:${symbol}`;
}

function emptyState(): State {
  return {
    trades: [],
    lastPrice: null,
    high24h: null,
    low24h: null,
    firstPrice24h: null,
    tradeCount: 0,
    volume: new Decimal(0),
    quoteVolume: new Decimal(0),
  };
}

@Injectable()
export class TickerStatsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TickerStatsService.name);
  private readonly state = new Map<string, State>();
  private readonly meta = new Map<string, TickerMeta>();
  private readonly emitter = new EventEmitter();
  private bootstrapped = false;

  constructor(private prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    // 1. meta cache — 모든 ticker 로드 (소수점 등)
    const tickers = await this.prisma.ticker.findMany();
    for (const t of tickers) {
      this.meta.set(keyOf(t.marketType, t.symbol), {
        symbol: t.symbol,
        marketType: t.marketType,
        baseAsset: t.baseAssetSymbol,
        quoteAsset: t.quoteAssetSymbol,
        pricePrecision: t.pricePrecision,
        qtyPrecision: t.qtyPrecision,
        minNotional: t.minNotional,
      });
    }

    // 2. rehydrate 24h — bootstrap flag가 false인 동안 emit 안 함
    const since = new Date(Date.now() - WINDOW_MS);
    const trades = await this.prisma.trade.findMany({
      where: { executedAt: { gte: since } },
      orderBy: [{ executedAt: 'asc' }, { seq: 'asc' }],
      select: {
        id: true,
        tickerSymbol: true,
        tickerMarket: true,
        price: true,
        qty: true,
        takerSide: true,
        executedAt: true,
      },
    });

    for (const t of trades) {
      this.applyTrade({
        market: t.tickerMarket,
        symbol: t.tickerSymbol,
        tradeId: t.id,
        price: t.price,
        qty: t.qty,
        takerSide: t.takerSide,
        ts: t.executedAt.getTime(),
      });
    }

    this.bootstrapped = true;
    this.logger.log(`rehydrated: ${this.meta.size} tickers, ${trades.length} trades in 24h window`);
  }

  applyTrade(event: TradeEvent): void {
    const key = keyOf(event.market, event.symbol);
    let s = this.state.get(key);
    if (!s) {
      s = emptyState();
      this.state.set(key, s);
    }

    const entry: TradeEntry = {
      price: event.price,
      qty: event.qty,
      createdAt: event.ts,
    };

    s.trades.push(entry);
    s.lastPrice = entry.price;
    s.tradeCount += 1;
    s.volume = s.volume.add(entry.qty);
    s.quoteVolume = s.quoteVolume.add(entry.price.mul(entry.qty));
    s.high24h = s.high24h === null || entry.price.gt(s.high24h) ? entry.price : s.high24h;
    s.low24h = s.low24h === null || entry.price.lt(s.low24h) ? entry.price : s.low24h;

    this.evict(s, Date.now());

    if (this.bootstrapped) this.emitter.emit('trade', event);
  }

  onTrade(listener: (event: TradeEvent) => void): () => void {
    this.emitter.on('trade', listener);
    return () => this.emitter.off('trade', listener);
  }

  snapshotOne(market: MarketType, symbol: string): Ticker24h | null {
    const meta = this.meta.get(keyOf(market, symbol));
    if (!meta) return null;
    return this.compose(meta);
  }

  snapshotAll(market: MarketType): Ticker24h[] {
    const result: Ticker24h[] = [];
    for (const meta of this.meta.values()) {
      if (meta.marketType === market) result.push(this.compose(meta));
    }
    result.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return result;
  }

  private compose(meta: TickerMeta): Ticker24h {
    const s = this.state.get(keyOf(meta.marketType, meta.symbol));
    if (s) this.evict(s, Date.now());

    const last = s?.lastPrice ?? null;
    const first = s?.firstPrice24h ?? null;
    let change: Decimal | null = null;
    let changePct: Decimal | null = null;
    if (first !== null && last !== null && !first.isZero()) {
      change = last.sub(first);
      changePct = change.div(first).mul(100);
    }

    return {
      symbol: meta.symbol,
      marketType: meta.marketType,
      baseAsset: meta.baseAsset,
      quoteAsset: meta.quoteAsset,
      pricePrecision: meta.pricePrecision,
      qtyPrecision: meta.qtyPrecision,
      lastPrice: last?.toFixed(meta.pricePrecision) ?? null,
      open24h: first?.toFixed(meta.pricePrecision) ?? null,
      priceChange24h: change?.toFixed(meta.pricePrecision) ?? null,
      priceChangePct24h: changePct?.toFixed(2) ?? null,
      high24h: s?.high24h?.toFixed(meta.pricePrecision) ?? null,
      low24h: s?.low24h?.toFixed(meta.pricePrecision) ?? null,
      volume24h: (s?.volume ?? new Decimal(0)).toFixed(meta.qtyPrecision),
      quoteVolume24h: (s?.quoteVolume ?? new Decimal(0)).toFixed(meta.pricePrecision),
      tradeCount24h: s?.tradeCount ?? 0,
    };
  }

  metaOf(market: MarketType, symbol: string): TickerMeta | null {
    return this.meta.get(keyOf(market, symbol)) ?? null;
  }

  /**
   * 컨트롤 토픽 add를 meta 캐시에 반영 — 신규 상장이 재시작 없이 market-data에 노출되게 한다
   * (meta는 boot 1회 로드라 이 upsert가 없으면 다음 재시작까지 안 보임).
   */
  upsertMetaFromControl(
    market: MarketType,
    p: {
      symbol: string;
      baseAsset: string;
      quoteAsset: string;
      pricePrecision: number;
      qtyPrecision: number;
      minNotional: string;
    },
  ): void {
    this.meta.set(keyOf(market, p.symbol), {
      symbol: p.symbol,
      marketType: market,
      baseAsset: p.baseAsset,
      quoteAsset: p.quoteAsset,
      pricePrecision: p.pricePrecision,
      qtyPrecision: p.qtyPrecision,
      minNotional: new Decimal(p.minNotional),
    });
    this.logger.log(`meta upserted (control): ${market}:${p.symbol}`);
  }

  /**
   * 신규 주문 게이트 — status가 TRADING이 아니면 거부. status는 DB 라이브 조회
   * (meta 캐시는 boot 1회라 admin 상태변경 즉시 반영 안 됨 → halt/delist는 즉시 효력 필요).
   */
  async assertTradable(market: MarketType, symbol: string): Promise<void> {
    const ticker = await this.prisma.ticker.findUnique({
      where: { symbol_marketType: { symbol, marketType: market } },
      select: { status: true },
    });
    if (!ticker)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        'Ticker not found',
        HttpStatus.NOT_FOUND,
      );
    if (ticker.status !== TickerStatus.TRADING)
      throw new DomainException(
        ErrorCode.TICKER_NOT_TRADABLE,
        `Trading is not open for ${symbol} (status: ${ticker.status})`,
        HttpStatus.FORBIDDEN,
      );
  }

  metaAll(market: MarketType): TickerMeta[] {
    const result: TickerMeta[] = [];
    for (const meta of this.meta.values()) {
      if (meta.marketType === market) result.push(meta);
    }
    result.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return result;
  }

  /** 최근 5분 qty 가중평균가. 5분 내 체결 없으면 lastPrice, 그것도 없으면 null. */
  avgPrice5m(market: MarketType, symbol: string): string | null {
    const meta = this.meta.get(keyOf(market, symbol));
    if (!meta) return null;
    const s = this.state.get(keyOf(market, symbol));
    if (!s) return null;
    this.evict(s, Date.now());

    const cutoff = Date.now() - AVG_PRICE_WINDOW_MS;
    let qty = new Decimal(0);
    let notional = new Decimal(0);
    for (let i = s.trades.length - 1; i >= 0; i--) {
      const t = s.trades[i];
      if (t.createdAt < cutoff) break;
      qty = qty.add(t.qty);
      notional = notional.add(t.price.mul(t.qty));
    }
    if (!qty.isZero()) return notional.div(qty).toFixed(meta.pricePrecision);
    return s.lastPrice?.toFixed(meta.pricePrecision) ?? null;
  }

  /**
   * 임의 윈도(windowMs) 집계 — Trade SQL (executedAt 기준).
   * 필드명은 Ticker24h를 재사용하되 의미는 요청 윈도 기준. 미상장 ticker면 null.
   */
  async rollingWindowStats(
    market: MarketType,
    symbol: string,
    windowMs: number,
  ): Promise<Ticker24h | null> {
    const meta = this.meta.get(keyOf(market, symbol));
    if (!meta) return null;

    const since = new Date(Date.now() - windowMs);
    const rows = await this.prisma.$queryRaw<
      {
        open: Decimal | null;
        close: Decimal | null;
        high: Decimal | null;
        low: Decimal | null;
        volume: Decimal | null;
        quote_volume: Decimal | null;
        trade_count: number;
      }[]
    >`
      SELECT (array_agg(t.price ORDER BY t.seq ASC))[1]  AS open,
             (array_agg(t.price ORDER BY t.seq DESC))[1] AS close,
             max(t.price)                                 AS high,
             min(t.price)                                 AS low,
             sum(t.qty)                                   AS volume,
             sum(t.price * t.qty)                         AS quote_volume,
             count(*)::int                                AS trade_count
      FROM "Trade" t
      WHERE t."tickerSymbol" = ${symbol}
        AND t."tickerMarket" = ${market}::"MarketType"
        AND t."executedAt" >= ${since}
    `;
    const r = rows[0];
    const open = r?.open ?? null;
    const close = r?.close ?? null;

    let change: Decimal | null = null;
    let changePct: Decimal | null = null;
    if (open !== null && close !== null && !open.isZero()) {
      change = close.sub(open);
      changePct = change.div(open).mul(100);
    }

    return {
      symbol: meta.symbol,
      marketType: meta.marketType,
      baseAsset: meta.baseAsset,
      quoteAsset: meta.quoteAsset,
      pricePrecision: meta.pricePrecision,
      qtyPrecision: meta.qtyPrecision,
      lastPrice: close?.toFixed(meta.pricePrecision) ?? null,
      open24h: open?.toFixed(meta.pricePrecision) ?? null,
      priceChange24h: change?.toFixed(meta.pricePrecision) ?? null,
      priceChangePct24h: changePct?.toFixed(2) ?? null,
      high24h: r?.high?.toFixed(meta.pricePrecision) ?? null,
      low24h: r?.low?.toFixed(meta.pricePrecision) ?? null,
      volume24h: (r?.volume ?? new Decimal(0)).toFixed(meta.qtyPrecision),
      quoteVolume24h: (r?.quote_volume ?? new Decimal(0)).toFixed(meta.pricePrecision),
      tradeCount24h: r?.trade_count ?? 0,
    };
  }

  private evict(s: State, now: number): void {
    const cutoff = now - WINDOW_MS;
    let evicted = 0;
    let evictedHigh = false;
    let evictedLow = false;

    while (s.trades.length > 0 && s.trades[0].createdAt < cutoff) {
      const dropped = s.trades.shift()!;
      s.tradeCount -= 1;
      s.volume = s.volume.sub(dropped.qty);
      s.quoteVolume = s.quoteVolume.sub(dropped.price.mul(dropped.qty));
      if (s.high24h !== null && dropped.price.eq(s.high24h)) evictedHigh = true;
      if (s.low24h !== null && dropped.price.eq(s.low24h)) evictedLow = true;
      evicted += 1;
    }

    if (evicted === 0) {
      if (s.firstPrice24h === null && s.trades.length > 0) {
        s.firstPrice24h = s.trades[0].price;
      }
      return;
    }

    if (s.trades.length === 0) {
      s.firstPrice24h = null;
      s.high24h = null;
      s.low24h = null;
      s.lastPrice = null;
      return;
    }

    s.firstPrice24h = s.trades[0].price;

    if (evictedHigh || evictedLow) {
      let high = s.trades[0].price;
      let low = s.trades[0].price;
      for (const t of s.trades) {
        if (t.price.gt(high)) high = t.price;
        if (t.price.lt(low)) low = t.price;
      }
      if (evictedHigh) s.high24h = high;
      if (evictedLow) s.low24h = low;
    }
  }
}
