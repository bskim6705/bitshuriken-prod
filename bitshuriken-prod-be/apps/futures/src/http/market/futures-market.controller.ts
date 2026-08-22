import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MarketType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService } from '@app/core-domain/ticker/ticker-stats.service';
import { OrderBookCacheService } from '@app/core-domain/orderbook/orderbook-cache.service';
import { KlineService } from '@app/core-domain/kline/kline.service';
import { KLINE_INTERVALS, isKlineInterval } from '@app/core-domain/kline/intervals';
import { MarkPriceService } from '../../mark-price/mark-price.service';
import { FuturesConfigService } from '../../config/futures-config.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { fmtScaled } from '@app/shared/decimal';
import { Weight } from '@app/shared/rate-limit/weight.decorator';
import { buildRateLimits } from '@app/shared/rate-limit/rate-limit.config';
import { limitsForApp } from '@app/shared/rate-limit/rate-limit.defaults';

const MAX_DEPTH_LEVELS = 50;
const DEFAULT_KLINE_LIMIT = 500;
const MAX_RECENT_LIMIT = 500;

/** 공개 market data — guard 없음 (spot market controller와 동일 패턴). */
@ApiTags('futures/market')
@Controller('futures/market')
export class FuturesMarketController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickerStats: TickerStatsService,
    private readonly obCache: OrderBookCacheService,
    private readonly klineService: KlineService,
    private readonly markPriceService: MarkPriceService,
    private readonly futuresConfig: FuturesConfigService,
  ) {}

  @Get('exchange-info')
  @Weight(20)
  @ApiOperation({ summary: 'Symbols, precisions, kline intervals, per-symbol max leverage' })
  @ApiResponse({
    status: 200,
    description: 'Server time, supported kline intervals and per-symbol trading rules.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        serverTime: 1749888000000,
        klineIntervals: ['1m', '5m', '15m', '1h', '4h', '1d'],
        symbols: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            pricePrecision: 2,
            qtyPrecision: 3,
            tickSize: '0.01',
            stepSize: '0.001',
            minNotional: '5.00000000',
            maxLeverage: 125,
          },
        ],
      },
    },
  })
  async exchangeInfo() {
    const symbols = await Promise.all(
      this.tickerStats.metaAll(MarketType.FUTURES).map(async (m) => {
        const config = await this.futuresConfig.configOf(m.symbol);
        return {
          symbol: m.symbol,
          baseAsset: m.baseAsset,
          quoteAsset: m.quoteAsset,
          pricePrecision: m.pricePrecision,
          qtyPrecision: m.qtyPrecision,
          tickSize: sizeFromPrecision(m.pricePrecision),
          stepSize: sizeFromPrecision(m.qtyPrecision),
          minNotional: m.minNotional.toFixed(8),
          maxLeverage: config.maxLeverage,
        };
      }),
    );
    return {
      serverTime: Date.now(),
      klineIntervals: [...KLINE_INTERVALS],
      symbols,
      rateLimits: buildRateLimits(limitsForApp('futures')),
    };
  }

  @Get('tickers')
  @Weight(80)
  @ApiOperation({ summary: '24h rolling ticker snapshot for all futures symbols' })
  @ApiResponse({
    status: 200,
    description: '24h stats snapshot per symbol.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          symbol: 'BTCUSDT',
          lastPrice: '51000.00000000',
          open24h: '50000.00000000',
          high24h: '52000.00000000',
          low24h: '49500.00000000',
          volume24h: '1234.56700000',
          quoteVolume24h: '62000000.00000000',
        },
      ],
    },
  })
  findTickers() {
    return this.tickerStats.snapshotAll(MarketType.FUTURES);
  }

  @Get('depth')
  @Weight(5)
  @ApiOperation({ summary: 'Order book depth (bids/asks up to 50 levels)' })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: true,
    description: 'Symbol, e.g. BTCUSDT',
  })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: `Number of price levels per side (default ${MAX_DEPTH_LEVELS}, capped at ${MAX_DEPTH_LEVELS})`,
  })
  @ApiResponse({
    status: 200,
    description: 'Aggregated order book; bids/asks are [price, qty] string tuples.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        lastUpdateId: 105432,
        bids: [
          ['50990.00', '0.500'],
          ['50980.00', '1.200'],
        ],
        asks: [
          ['51010.00', '0.300'],
          ['51020.00', '0.800'],
        ],
      },
    },
  })
  depth(
    @Query('symbol') symbol: string,
    @Query('limit', new DefaultValuePipe(MAX_DEPTH_LEVELS), ParseIntPipe) limit: number,
  ) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    const meta = this.tickerStats.metaOf(MarketType.FUTURES, symbol);
    if (!meta)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        `unknown ticker ${symbol}`,
        HttpStatus.NOT_FOUND,
      );
    const levels = Math.min(Math.max(1, limit), MAX_DEPTH_LEVELS);
    const raw = this.obCache.getDepth(MarketType.FUTURES, symbol, levels);
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
  @ApiOperation({ summary: 'Best bid/ask price and quantity' })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: true,
    description: 'Symbol, e.g. BTCUSDT',
  })
  @ApiResponse({
    status: 200,
    description: 'Best bid/ask snapshot.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        symbol: 'BTCUSDT',
        bidPrice: '50990.00',
        bidQty: '0.500',
        askPrice: '51010.00',
        askQty: '0.300',
        lastUpdateId: 105432,
      },
    },
  })
  bookTicker(@Query('symbol') symbol: string) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    const meta = this.tickerStats.metaOf(MarketType.FUTURES, symbol);
    if (!meta)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        `unknown ticker ${symbol}`,
        HttpStatus.NOT_FOUND,
      );
    const t = this.obCache.getBookTicker(MarketType.FUTURES, symbol);
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

  @Get('recent-trades')
  @ApiOperation({ summary: 'Most recent public trades for a symbol (newest first)' })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: true,
    description: 'Symbol, e.g. BTCUSDT',
  })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: `Max rows (default 50, capped at ${MAX_RECENT_LIMIT})`,
  })
  @ApiResponse({
    status: 200,
    description: 'Recent trades, newest first.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: 'trd_19af',
          tickerSymbol: 'BTCUSDT',
          tickerMarket: 'FUTURES',
          takerSide: 'BUY',
          price: '51000.00000000',
          qty: '0.05000000',
          createdAt: '2026-06-14T08:00:00.000Z',
        },
      ],
    },
  })
  recentTrades(
    @Query('symbol') symbol: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    const safeLimit = Math.min(Math.max(1, limit), MAX_RECENT_LIMIT);
    return this.prisma.trade.findMany({
      where: { tickerSymbol: symbol, tickerMarket: MarketType.FUTURES },
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

  @Get('klines')
  @ApiOperation({ summary: 'Klines (named-object shape, current partial bucket included)' })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: true,
    description: 'Symbol, e.g. BTCUSDT',
  })
  @ApiQuery({
    name: 'interval',
    type: String,
    required: true,
    description: 'Kline interval (e.g. 1m, 5m, 15m, 1h, 4h, 1d) — see exchange-info',
  })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: `Number of candles (default ${DEFAULT_KLINE_LIMIT})`,
  })
  @ApiQuery({
    name: 'endTime',
    type: Number,
    required: false,
    description: 'Return candles at or before this epoch ms',
  })
  @ApiResponse({
    status: 200,
    description: 'Candles oldest-to-newest; last entry is the current partial bucket.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          openTime: 1749888000000,
          open: '50000.00000000',
          high: '50500.00000000',
          low: '49900.00000000',
          close: '51000.00000000',
          volume: '120.50000000',
          quoteVolume: '6050000.00000000',
          closeTime: 1749888059999,
          trades: 342,
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
      MarketType.FUTURES,
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

  @Get('mark-price')
  @ApiOperation({ summary: 'Mark/index price + funding info (null until spot index forms)' })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: true,
    description: 'Symbol, e.g. BTCUSDT',
  })
  @ApiResponse({
    status: 200,
    description: 'Mark/index price and funding info; price fields are null until the index forms.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        symbol: 'BTCUSDT',
        markPrice: '51000.00000000',
        indexPrice: '50995.00000000',
        lastFundingRate: '0.00010000',
        nextFundingTime: 1749916800000,
      },
    },
  })
  async markPrice(@Query('symbol') symbol: string) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    const meta = this.tickerStats.metaOf(MarketType.FUTURES, symbol);
    if (!meta)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        `unknown ticker ${symbol}`,
        HttpStatus.NOT_FOUND,
      );
    const mark = this.markPriceService.tryGetMark(symbol);
    const index = this.markPriceService.getIndex(symbol);
    const last = await this.markPriceService.lastFundingRate(symbol);
    return {
      symbol,
      markPrice: mark?.toFixed(8) ?? null,
      indexPrice: index?.toFixed(8) ?? null,
      lastFundingRate: last?.rate.toFixed(8) ?? null,
      nextFundingTime: this.markPriceService.nextFundingTime().getTime(),
    };
  }

  @Get('funding-rate')
  @ApiOperation({ summary: 'Funding rate history (latest first)' })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: true,
    description: 'Symbol, e.g. BTCUSDT',
  })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: `Max rows (default 50, capped at ${MAX_RECENT_LIMIT})`,
  })
  @ApiResponse({
    status: 200,
    description: 'Historical funding rates, newest first.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          symbol: 'BTCUSDT',
          fundingTime: 1749916800000,
          rate: '0.00010000',
          markPrice: '51000.00000000',
        },
      ],
    },
  })
  async fundingRate(
    @Query('symbol') symbol: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    const safeLimit = Math.min(Math.max(1, limit), MAX_RECENT_LIMIT);
    const rows = await this.prisma.fundingRate.findMany({
      where: { tickerSymbol: symbol },
      orderBy: { fundingTime: 'desc' },
      take: safeLimit,
    });
    return rows.map((r) => ({
      symbol: r.tickerSymbol,
      fundingTime: r.fundingTime.getTime(),
      rate: r.rate.toFixed(8),
      markPrice: r.markPrice.toFixed(8),
    }));
  }
}

/** precision → "0.01" 형태의 tick/step 문자열 (10^-precision). */
function sizeFromPrecision(precision: number): string {
  return new Decimal(10).pow(-precision).toFixed(precision);
}
