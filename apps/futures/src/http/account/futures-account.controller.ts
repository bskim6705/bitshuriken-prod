import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { FuturesIncomeType } from '@prisma/client';
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { PrivateGuard } from '@app/core-domain/auth/guards/private.guard';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { FuturesAccountService } from './futures-account.service';

const DEFAULT_HISTORY_LIMIT = 100;

@ApiTags('futures/account')
@ApiSecurity('cookieAuth')
@ApiSecurity('apiKey')
@UseGuards(PrivateGuard)
@Controller('futures/account')
export class FuturesAccountController {
  constructor(private readonly accountService: FuturesAccountService) {}

  @Get()
  @ApiOperation({ summary: 'Account aggregate (wallet balance + positions margin math)' })
  @ApiResponse({
    status: 200,
    description: 'Aggregate wallet balance, unrealized PnL, margin and available balance.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        totalWalletBalance: '10000.00000000',
        totalUnrealizedProfit: '125.50000000',
        totalMarginBalance: '10125.50000000',
        availableBalance: '9500.00000000',
        totalMaintMargin: '50.00000000',
        totalPositionInitialMargin: '500.00000000',
      },
    },
  })
  account(@CurrentUser() user: CurrentUserPayload) {
    return this.accountService.accountSummary(user.userId);
  }

  @Get('balances')
  @ApiOperation({ summary: 'Futures wallet balances per asset' })
  @ApiResponse({
    status: 200,
    description: 'Per-asset FUTURES wallet rows.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          userId: 'usr_42',
          assetSymbol: 'USDT',
          marketType: 'FUTURES',
          balance: '10000.00000000',
          locked: '500.00000000',
        },
      ],
    },
  })
  findBalances(@CurrentUser() user: CurrentUserPayload) {
    return this.accountService.findBalances(user.userId);
  }

  @Get('positions')
  @ApiOperation({ summary: 'Positions with mark/UPNL/liq.price/margin ratio (null until mark)' })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: false,
    description: 'Optional symbol filter, e.g. BTCUSDT',
  })
  @ApiResponse({
    status: 200,
    description: 'Positions with derived mark price, UPNL, liquidation price and margin ratio.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          symbol: 'BTCUSDT',
          qty: '0.10000000',
          entryPrice: '50000.00000000',
          isolatedMargin: '500.00000000',
          leverage: 10,
          marginMode: 'ISOLATED',
          status: 'NORMAL',
          markPrice: '51000.00000000',
          unrealizedPnl: '100.00000000',
          liquidationPrice: '45500.00000000',
          marginRatio: '0.08000000',
          updatedAt: '2026-06-14T08:00:00.000Z',
        },
      ],
    },
  })
  findPositions(@CurrentUser() user: CurrentUserPayload, @Query('symbol') symbol?: string) {
    return this.accountService.findPositions(user.userId, symbol);
  }

  @Get('leverage-bracket')
  @ApiOperation({ summary: 'Leverage brackets (single-MMR: one bracket per symbol)' })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: false,
    description: 'Optional symbol filter; omit for all futures symbols',
  })
  @ApiResponse({
    status: 200,
    description: 'Single-tier leverage bracket per symbol.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          symbol: 'BTCUSDT',
          brackets: [
            {
              bracket: 1,
              notionalCap: '1000000.00000000',
              notionalFloor: '0',
              maintMarginRatio: '0.00500000',
              maxLeverage: 125,
              liquidationFeeRate: '0.00200000',
            },
          ],
        },
      ],
    },
  })
  leverageBracket(@Query('symbol') symbol?: string) {
    return this.accountService.leverageBrackets(symbol);
  }

  @Get('commission-rate')
  @ApiOperation({ summary: "Requesting user's maker/taker commission rates" })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: true,
    description: 'Symbol, e.g. BTCUSDT (rate is tier-based, same across symbols)',
  })
  @ApiResponse({
    status: 200,
    description: 'Maker/taker commission rates as 8dp decimal strings.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        symbol: 'BTCUSDT',
        makerCommissionRate: '0.00020000',
        takerCommissionRate: '0.00040000',
      },
    },
  })
  commissionRate(@CurrentUser() user: CurrentUserPayload, @Query('symbol') symbol?: string) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    return this.accountService.commissionRate(user.userId, symbol);
  }

  @Get('open-orders')
  @ApiOperation({ summary: 'Open orders (NEW/OPEN/PARTIAL), optional symbol filter' })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: false,
    description: 'Optional symbol filter, e.g. BTCUSDT',
  })
  @ApiResponse({
    status: 200,
    description: 'Currently open orders (status NEW, OPEN or PARTIAL).',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: 'ord_8sf0a1',
          tickerSymbol: 'BTCUSDT',
          tickerMarket: 'FUTURES',
          type: 'LIMIT',
          side: 'BUY',
          price: '50000.00000000',
          origQty: '0.10000000',
          executedQty: '0.04000000',
          status: 'PARTIAL',
          reduceOnly: false,
          createdAt: '2026-06-14T08:00:00.000Z',
        },
      ],
    },
  })
  findOpenOrders(@CurrentUser() user: CurrentUserPayload, @Query('symbol') symbol?: string) {
    return this.accountService.findOpenOrders(user.userId, symbol);
  }

  @Get('orders')
  @ApiOperation({ summary: 'Order history (endTime cursor, epoch ms inclusive)' })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: `Max rows (default ${DEFAULT_HISTORY_LIMIT}, capped at 500)`,
  })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: false,
    description: 'Optional symbol filter, e.g. BTCUSDT',
  })
  @ApiQuery({
    name: 'endTime',
    type: Number,
    required: false,
    description: 'Cursor: only orders created at or before this epoch ms (inclusive)',
  })
  @ApiResponse({
    status: 200,
    description: 'Order history, newest first.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: 'ord_8sf0a1',
          tickerSymbol: 'BTCUSDT',
          tickerMarket: 'FUTURES',
          type: 'LIMIT',
          side: 'BUY',
          price: '50000.00000000',
          origQty: '0.10000000',
          executedQty: '0.10000000',
          status: 'FILLED',
          reduceOnly: false,
          createdAt: '2026-06-14T08:00:00.000Z',
        },
      ],
    },
  })
  findOrders(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit', new DefaultValuePipe(DEFAULT_HISTORY_LIMIT), ParseIntPipe) limit: number,
    @Query('symbol') symbol?: string,
    @Query('endTime', new ParseIntPipe({ optional: true })) endTime?: number,
  ) {
    return this.accountService.findOrders(user.userId, { symbol, limit, endTime });
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'Single futures order by id or clientOrderId (own orders only)' })
  @ApiParam({ name: 'id', type: String, description: 'Order id (uuid) or clientOrderId' })
  findOrder(@CurrentUser() user: CurrentUserPayload, @Param('id') ref: string) {
    return this.accountService.findOrder(user.userId, ref);
  }

  @Get('trades')
  @ApiOperation({ summary: 'My trades (own-side commission only, time = epoch ms)' })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: `Max rows (default ${DEFAULT_HISTORY_LIMIT}, capped at 500)`,
  })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: false,
    description: 'Optional symbol filter, e.g. BTCUSDT',
  })
  @ApiQuery({
    name: 'endTime',
    type: Number,
    required: false,
    description: 'Cursor: only trades executed at or before this epoch ms (inclusive)',
  })
  @ApiResponse({
    status: 200,
    description: 'Your trades; only your own side commission is exposed.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: 'trd_19af',
          orderId: 'ord_8sf0a1',
          symbol: 'BTCUSDT',
          market: 'FUTURES',
          price: '50000.00000000',
          qty: '0.10000000',
          quoteQty: '5000.00000000',
          commission: '2.00000000',
          commissionAsset: 'USDT',
          isBuyer: true,
          isMaker: false,
          time: 1749888000000,
        },
      ],
    },
  })
  findTrades(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit', new DefaultValuePipe(DEFAULT_HISTORY_LIMIT), ParseIntPipe) limit: number,
    @Query('symbol') symbol?: string,
    @Query('endTime', new ParseIntPipe({ optional: true })) endTime?: number,
  ) {
    return this.accountService.findMyTrades(user.userId, { symbol, limit, endTime });
  }

  @Get('income')
  @ApiOperation({ summary: 'Income ledger (latest first), optional incomeType/symbol filter' })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: `Max rows (default ${DEFAULT_HISTORY_LIMIT}, capped at 500)`,
  })
  @ApiQuery({
    name: 'incomeType',
    enum: FuturesIncomeType,
    required: false,
    description: 'Optional income type filter (e.g. REALIZED_PNL, FUNDING_FEE, COMMISSION)',
  })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: false,
    description: 'Optional symbol filter, e.g. BTCUSDT',
  })
  @ApiResponse({
    status: 200,
    description: 'Income ledger entries, newest first.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: 'inc_77c1',
          userId: 'usr_42',
          tickerSymbol: 'BTCUSDT',
          incomeType: 'FUNDING_FEE',
          income: '-1.25000000',
          asset: 'USDT',
          createdAt: '2026-06-14T08:00:00.000Z',
        },
      ],
    },
  })
  findIncome(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit', new DefaultValuePipe(DEFAULT_HISTORY_LIMIT), ParseIntPipe) limit: number,
    @Query('incomeType', new ParseEnumPipe(FuturesIncomeType, { optional: true }))
    incomeType?: FuturesIncomeType,
    @Query('symbol') symbol?: string,
  ) {
    return this.accountService.findIncome(user.userId, { incomeType, symbol, limit });
  }
}
