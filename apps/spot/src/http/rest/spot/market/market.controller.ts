import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MarketType, OrderType, TimeInForce } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { TradeService } from '../../../../domain/trade/trade.service';
import { OrderBookCacheService } from '@app/core-domain/orderbook/orderbook-cache.service';
import { KlineService } from '@app/core-domain/kline/kline.service';
import { KLINE_INTERVALS, isKlineInterval } from '@app/core-domain/kline/intervals';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { fmtScaled } from '@app/shared/decimal';
import { Weight } from '@app/shared/rate-limit/weight.decorator';
import { buildRateLimits } from '@app/shared/rate-limit/rate-limit.config';
import { limitsForApp } from '@app/shared/rate-limit/rate-limit.defaults';

const MAX_DEPTH_LEVELS = 50;
const DEFAULT_KLINE_LIMIT = 500;

const TICKER_WINDOW_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

@ApiTags('spot/market')
@Controller('spot/market')
export class MarketController {
  constructor(
    private readonly tickerStats: TickerStatsService,
    private readonly tradeService: TradeService,
    private readonly obCache: OrderBookCacheService,
    private readonly klineService: KlineService,
  ) {}

  @Get('time')
  @ApiOperation({ summary: 'Server time' })
  @ApiResponse({
    status: 200,
    description: 'Current server epoch ms',
    example: { code: 0, message: 'ok', data: { serverTime: 1718000000000 } },
  })
  time() {
    return { serverTime: Date.now() };
  }

  @Get('exchange-info')
  @Weight(20)
  @ApiOperation({ summary: 'Symbols, precisions, order types, kline intervals' })
  @ApiResponse({
    status: 200,
    description:
      'Trading rules: supported symbols with precision/tick/step, order types, intervals',
    example: {
      code: 0,
      message: 'ok',
      data: {
        serverTime: 1718000000000,
        klineIntervals: ['1m', '5m', '15m', '1h', '4h', '1d'],
        orderTypes: ['LIMIT', 'MARKET', 'STOP_LOSS_LIMIT'],
        timeInForce: ['GTC', 'IOC', 'FOK'],
        symbols: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            pricePrecision: 2,
            qtyPrecision: 8,
            tickSize: '0.01',
            stepSize: '0.00000001',
            minNotional: '10.00000000',
            ocoAllowed: true,
          },
        ],
      },
    },
  })
  exchangeInfo() {
    const symbols = this.tickerStats.metaAll(MarketType.SPOT).map((m) => ({
      symbol: m.symbol,
      baseAsset: m.baseAsset,
      quoteAsset: m.quoteAsset,
      pricePrecision: m.pricePrecision,
      qtyPrecision: m.qtyPrecision,
      tickSize: sizeFromPrecision(m.pricePrecision),
      stepSize: sizeFromPrecision(m.qtyPrecision),
      minNotional: m.minNotional.toFixed(8),
      ocoAllowed: true, // 플랫폼 상수 — 전 심볼 OCO 허용
    }));
    return {
      serverTime: Date.now(),
      klineIntervals: [...KLINE_INTERVALS],
      orderTypes: Object.values(OrderType),
      timeInForce: Object.values(TimeInForce),
      symbols,
      rateLimits: buildRateLimits(limitsForApp('spot')),
    };
  }

  @Get('tickers')
  @Weight(80)
  @ApiOperation({ summary: '24h rolling stats for all symbols' })
  findTickers() {
    return this.tickerStats.snapshotAll(MarketType.SPOT);
  }

  @Get('ticker-24h')
  @ApiOperation({ summary: '24h rolling stats for one symbol' })
  @ApiQuery({ name: 'symbol', type: String, required: true, description: 'e.g. BTCUSDT' })
  @ApiResponse({
    status: 200,
    description: '24h price/volume stats for the symbol',
    example: {
      code: 0,
      message: 'ok',
      data: {
        symbol: 'BTCUSDT',
        marketType: 'SPOT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        pricePrecision: 2,
        qtyPrecision: 8,
        lastPrice: '50000.00',
        open24h: '49000.00',
        priceChange24h: '1000.00',
        priceChangePct24h: '2.04',
        high24h: '51000.00',
        low24h: '48500.00',
        volume24h: '123.45000000',
        quoteVolume24h: '6172500.00',
        tradeCount24h: 482,
      },
    },
  })
  ticker24h(@Query('symbol') symbol: string) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    const ticker = this.tickerStats.snapshotOne(MarketType.SPOT, symbol);
    if (!ticker)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        `unknown ticker ${symbol}`,
        HttpStatus.NOT_FOUND,
      );
    return ticker;
  }

  @Get('ticker')
  @ApiOperation({ summary: 'Rolling window stats (windowSize required: 1h|4h|1d|7d)' })
  @ApiQuery({ name: 'symbol', type: String, required: true, description: 'e.g. BTCUSDT' })
  @ApiQuery({
    name: 'windowSize',
    type: String,
    required: true,
    description: 'Rolling window: 1h | 4h | 1d | 7d',
  })
  async ticker(@Query('symbol') symbol: string, @Query('windowSize') windowSize: string) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    const windowMs = windowSize ? TICKER_WINDOW_MS[windowSize] : undefined;
    if (!windowMs) {
      throw new DomainException(ErrorCode.PARAM_REQUIRED, 'windowSize is required (1h|4h|1d|7d)');
    }
    const stats = await this.tickerStats.rollingWindowStats(MarketType.SPOT, symbol, windowMs);
    if (!stats)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        `unknown ticker ${symbol}`,
        HttpStatus.NOT_FOUND,
      );
    return { windowSize, ...stats };
  }

  @Get('ticker-price')
  @ApiOperation({ summary: 'Last price for one symbol, or all symbols' })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: false,
    description: 'One symbol e.g. BTCUSDT; omit to list all symbols',
  })
  @ApiResponse({
    status: 200,
    description: 'Last traded price; object for a single symbol, array when symbol omitted',
    example: { code: 0, message: 'ok', data: { symbol: 'BTCUSDT', price: '50000.00' } },
  })
  tickerPrice(@Query('symbol') symbol?: string) {
    if (symbol) {
      const t = this.tickerStats.snapshotOne(MarketType.SPOT, symbol);
      if (!t)
        throw new DomainException(
          ErrorCode.TICKER_NOT_FOUND,
          `unknown ticker ${symbol}`,
          HttpStatus.NOT_FOUND,
        );
      return { symbol: t.symbol, price: t.lastPrice };
    }
    return this.tickerStats
      .snapshotAll(MarketType.SPOT)
      .map((t) => ({ symbol: t.symbol, price: t.lastPrice }));
  }

  @Get('avg-price')
  @ApiOperation({ summary: '5-minute qty-weighted average price' })
  @ApiQuery({ name: 'symbol', type: String, required: true, description: 'e.g. BTCUSDT' })
  avgPrice(@Query('symbol') symbol: string) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    const avgPrice = this.tickerStats.avgPrice5m(MarketType.SPOT, symbol);
    if (avgPrice === null)
      throw new DomainException(
        ErrorCode.MARKET_DATA_NOT_FOUND,
        `no price available for ${symbol}`,
        HttpStatus.NOT_FOUND,
      );
    return { symbol, window: '5m', avgPrice };
  }

  @Get('klines')
  @Weight(2)
  @ApiOperation({ summary: 'Klines (named-object shape, current partial bucket included)' })
  @ApiQuery({ name: 'symbol', type: String, required: true, description: 'e.g. BTCUSDT' })
  @ApiQuery({
    name: 'interval',
    type: String,
    required: true,
    description: 'Bucket size: 1m | 5m | 15m | 1h | 4h | 1d',
  })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'Number of buckets (default 500)',
  })
  @ApiQuery({
    name: 'endTime',
    type: Number,
    required: false,
    description: 'Epoch ms cursor; return buckets up to this time',
  })
  @ApiResponse({
    status: 200,
    description:
      'Array of named klines; last element is the current partial bucket (isFinal=false)',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          symbol: 'BTCUSDT',
          interval: '1m',
          openTime: 1718000000000,
          closeTime: 1718000059999,
          open: '50000.00',
          high: '50100.00',
          low: '49950.00',
          close: '50080.00',
          volume: '12.34000000',
          quoteVolume: '617200.00',
          tradeCount: 42,
          isFinal: true,
        },
      ],
    },
  })
  async klines(
    @Query('symbol') symbol: string,
    @Query('interval') interval: string,
    @Query('limit', new DefaultValuePipe(DEFAULT_KLINE_LIMIT), ParseIntPipe) limit: number,
    @Query('endTime', new ParseIntPipe({ optional: true })) endTime?: number,
  ) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    if (!interval || !isKlineInterval(interval)) {
      throw new DomainException(
        ErrorCode.INVALID_PARAMETER,
        `unsupported interval (${KLINE_INTERVALS.join('|')})`,
      );
    }
    if (endTime !== undefined && endTime <= 0) {
      throw new DomainException(ErrorCode.INVALID_PARAMETER, 'endTime must be epoch ms');
    }
    const klines = await this.klineService.getKlines(
      MarketType.SPOT,
      symbol,
      interval,
      limit,
      endTime,
    );
    if (!klines)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        `unknown ticker ${symbol}`,
        HttpStatus.NOT_FOUND,
      );
    return klines;
  }

  @Get('recent-trades')
  @ApiOperation({ summary: 'Most recent public trades (no counterparty info)' })
  @ApiQuery({ name: 'symbol', type: String, required: true, description: 'e.g. BTCUSDT' })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'Max trades (default 50)',
  })
  @ApiResponse({
    status: 200,
    description: 'Recent trades, newest first',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: '8f1c2d3e-...',
          tickerSymbol: 'BTCUSDT',
          tickerMarket: 'SPOT',
          takerSide: 'BUY',
          price: '50000.00',
          qty: '0.01000000',
          createdAt: '2026-06-14T00:00:00.000Z',
        },
      ],
    },
  })
  recentTrades(
    @Query('symbol') symbol: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    return this.tradeService.findRecent(symbol, MarketType.SPOT, limit);
  }

  @Get('historical-trades')
  @ApiOperation({ summary: 'Older trades via endTime cursor (epoch ms, inclusive)' })
  @ApiQuery({ name: 'symbol', type: String, required: true, description: 'e.g. BTCUSDT' })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'Max trades (default 50)',
  })
  @ApiQuery({
    name: 'endTime',
    type: Number,
    required: false,
    description: 'Epoch ms cursor; return trades at or before this time',
  })
  historicalTrades(
    @Query('symbol') symbol: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('endTime', new ParseIntPipe({ optional: true })) endTime?: number,
  ) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    if (endTime !== undefined && endTime <= 0) {
      throw new DomainException(ErrorCode.INVALID_PARAMETER, 'endTime must be epoch ms');
    }
    return this.tradeService.historicalTrades(symbol, MarketType.SPOT, limit, endTime);
  }

  @Get('agg-trades')
  @ApiOperation({ summary: 'Trades aggregated by (taker order, price)' })
  @ApiQuery({ name: 'symbol', type: String, required: true, description: 'e.g. BTCUSDT' })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'Max aggregate groups (default 50)',
  })
  aggTrades(
    @Query('symbol') symbol: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    return this.tradeService.aggTrades(symbol, MarketType.SPOT, limit);
  }

  @Get('depth')
  @Weight(5)
  @ApiOperation({ summary: 'Order book depth (bids/asks as [price, qty] pairs)' })
  @ApiQuery({ name: 'symbol', type: String, required: true, description: 'e.g. BTCUSDT' })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'Price levels per side, 1..50 (default 50)',
  })
  @ApiResponse({
    status: 200,
    description: 'Top-of-book levels; bids descending, asks ascending',
    example: {
      code: 0,
      message: 'ok',
      data: {
        lastUpdateId: 1027024,
        bids: [
          ['49999.00', '0.50000000'],
          ['49998.50', '1.20000000'],
        ],
        asks: [
          ['50000.50', '0.30000000'],
          ['50001.00', '0.80000000'],
        ],
      },
    },
  })
  depth(
    @Query('symbol') symbol: string,
    @Query('limit', new DefaultValuePipe(MAX_DEPTH_LEVELS), ParseIntPipe) limit: number,
  ) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    const meta = this.tickerStats.metaOf(MarketType.SPOT, symbol);
    if (!meta)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        `unknown ticker ${symbol}`,
        HttpStatus.NOT_FOUND,
      );
    const levels = Math.min(Math.max(1, limit), MAX_DEPTH_LEVELS);
    const raw = this.obCache.getDepth(MarketType.SPOT, symbol, levels);
    const fmt = ([p, q]: [string, string]): [string, string] => [
      fmtScaled(p, meta.pricePrecision),
      fmtScaled(q, meta.qtyPrecision),
    ];
    return {
      lastUpdateId: raw.lastUpdateId,
      bids: raw.bids.map(fmt),
      asks: raw.asks.map(fmt),
    };
  }

  @Get('book-ticker')
  @ApiOperation({ summary: 'Best bid/ask price and qty' })
  @ApiQuery({ name: 'symbol', type: String, required: true, description: 'e.g. BTCUSDT' })
  @ApiResponse({
    status: 200,
    description: 'Best bid and ask for the symbol',
    example: {
      code: 0,
      message: 'ok',
      data: {
        symbol: 'BTCUSDT',
        bidPrice: '49999.00',
        bidQty: '0.50000000',
        askPrice: '50000.50',
        askQty: '0.30000000',
        lastUpdateId: 1027024,
      },
    },
  })
  bookTicker(@Query('symbol') symbol: string) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    const meta = this.tickerStats.metaOf(MarketType.SPOT, symbol);
    if (!meta)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        `unknown ticker ${symbol}`,
        HttpStatus.NOT_FOUND,
      );
    const t = this.obCache.getBookTicker(MarketType.SPOT, symbol);
    if (!t)
      throw new DomainException(
        ErrorCode.MARKET_DATA_NOT_FOUND,
        'No book ticker yet',
        HttpStatus.NOT_FOUND,
      );
    return {
      symbol: t.symbol,
      bidPrice: fmtScaled(t.bidPrice, meta.pricePrecision),
      bidQty: fmtScaled(t.bidQty, meta.qtyPrecision),
      askPrice: fmtScaled(t.askPrice, meta.pricePrecision),
      askQty: fmtScaled(t.askQty, meta.qtyPrecision),
      lastUpdateId: t.lastUpdateId,
    };
  }
}

/** precision → "0.01" 형태의 tick/step 문자열 (10^-precision). */
function sizeFromPrecision(precision: number): string {
  return new Decimal(10).pow(-precision).toFixed(precision);
}
