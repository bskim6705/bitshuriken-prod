import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { MarketType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { PrivateGuard } from '@app/core-domain/auth/guards/private.guard';
import { WalletService } from '@app/core-domain/wallet/wallet.service';
import { OrderService } from '../../../../domain/order/order.service';
import { TradeService } from '../../../../domain/trade/trade.service';
import { OrderListService } from '../../../../domain/order-list/order-list.service';
import { UserService } from '@app/core-domain/user/user.service';

const DEFAULT_HISTORY_LIMIT = 100;

@ApiTags('spot/account')
@ApiBearerAuth()
@ApiSecurity('cookieAuth')
@ApiSecurity('apiKey')
@UseGuards(PrivateGuard)
@Controller('spot/account')
export class AccountController {
  constructor(
    private readonly walletService: WalletService,
    private readonly orderService: OrderService,
    private readonly tradeService: TradeService,
    private readonly orderListService: OrderListService,
    private readonly userService: UserService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Consolidated account snapshot (balances + commission + flags)' })
  @ApiResponse({
    status: 200,
    description: 'Account snapshot with per-asset free/locked balances and commission rates (bps)',
    example: {
      code: 0,
      message: 'ok',
      data: {
        makerCommission: 10,
        takerCommission: 20,
        canTrade: true,
        canDeposit: true,
        canWithdraw: true,
        accountType: 'SPOT',
        balances: [
          { asset: 'USDT', free: '10000.00000000', locked: '0.00000000' },
          { asset: 'BTC', free: '0.50000000', locked: '0.10000000' },
        ],
        updateTime: 1718000000000,
      },
    },
  })
  async snapshot(@CurrentUser() user: CurrentUserPayload) {
    const [wallets, rates] = await Promise.all([
      this.walletService.findByUser(user.userId),
      this.userService.feeRatesOf(user.userId, MarketType.SPOT),
    ]);
    const spotWallets = wallets.filter((w) => w.marketType === MarketType.SPOT);
    const balances = spotWallets.map((w) => ({
      asset: w.assetSymbol,
      free: w.balance.toFixed(8),
      locked: w.locked.toFixed(8),
    }));
    const updateTime = spotWallets.reduce((max, w) => Math.max(max, w.updatedAt.getTime()), 0);
    return {
      makerCommission: rates.makerBps,
      takerCommission: rates.takerBps,
      canTrade: true,
      canDeposit: true,
      canWithdraw: true,
      accountType: 'SPOT',
      balances,
      updateTime,
    };
  }

  @Get('balances')
  @ApiOperation({ summary: 'Raw wallet rows for the user (all markets)' })
  @ApiResponse({
    status: 200,
    description: 'Wallet rows with balance (free) and locked amounts',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          assetSymbol: 'USDT',
          marketType: 'SPOT',
          balance: '10000.00000000',
          locked: '0.00000000',
          updatedAt: '2026-06-14T00:00:00.000Z',
        },
      ],
    },
  })
  findBalances(@CurrentUser() user: CurrentUserPayload) {
    return this.walletService.findByUser(user.userId);
  }

  @Get('open-orders')
  @ApiOperation({ summary: 'Open orders (NEW/OPEN/PARTIAL), optional symbol filter' })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: false,
    description: 'Filter by symbol e.g. BTCUSDT; omit for all',
  })
  @ApiResponse({
    status: 200,
    description: 'Currently open orders, newest first',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: '7b2c1a9e-...',
          tickerSymbol: 'BTCUSDT',
          tickerMarket: 'SPOT',
          side: 'BUY',
          type: 'LIMIT',
          timeInForce: 'GTC',
          price: '50000.00',
          origQty: '0.10000000',
          executedQty: '0.00000000',
          cumulativeQuoteQty: '0.00000000',
          status: 'NEW',
          createdAt: '2026-06-14T00:00:00.000Z',
        },
      ],
    },
  })
  findOpenOrders(@CurrentUser() user: CurrentUserPayload, @Query('symbol') symbol?: string) {
    return this.orderService.findOpenOrders(user.userId, MarketType.SPOT, symbol);
  }

  @Get('orders')
  @ApiOperation({ summary: 'Order history (endTime cursor, epoch ms inclusive)' })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'Max orders (default 100)',
  })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: false,
    description: 'Filter by symbol e.g. BTCUSDT',
  })
  @ApiQuery({
    name: 'endTime',
    type: Number,
    required: false,
    description: 'Epoch ms cursor; return orders at or before this time',
  })
  findOrders(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit', new DefaultValuePipe(DEFAULT_HISTORY_LIMIT), ParseIntPipe) limit: number,
    @Query('symbol') symbol?: string,
    @Query('endTime', new ParseIntPipe({ optional: true })) endTime?: number,
  ) {
    return this.orderService.findHistory(user.userId, MarketType.SPOT, {
      symbol,
      limit,
      endTime,
    });
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'Single order by id or clientOrderId (own orders only)' })
  @ApiParam({ name: 'id', type: String, description: 'Order id (uuid) or clientOrderId' })
  findOrder(@CurrentUser() user: CurrentUserPayload, @Param('id') orderId: string) {
    return this.orderService.findOneForUser(user.userId, orderId);
  }

  @Get('trades')
  @ApiOperation({ summary: 'My trades (own-side commission only, time = epoch ms)' })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'Max trades (default 100)',
  })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: false,
    description: 'Filter by symbol e.g. BTCUSDT',
  })
  @ApiQuery({
    name: 'endTime',
    type: Number,
    required: false,
    description: 'Epoch ms cursor; return trades at or before this time',
  })
  @ApiResponse({
    status: 200,
    description: 'My trades, newest first; own-side commission and maker/buyer flags',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: '8f1c2d3e-...',
          orderId: '7b2c1a9e-...',
          symbol: 'BTCUSDT',
          market: 'SPOT',
          price: '50000.00',
          qty: '0.01000000',
          quoteQty: '500.00',
          commission: '0.00001000',
          commissionAsset: 'BTC',
          isBuyer: true,
          isMaker: false,
          time: 1718000000000,
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
    return this.tradeService.findMyTrades(user.userId, MarketType.SPOT, {
      symbol,
      limit,
      endTime,
    });
  }

  @Get('order-lists')
  @ApiOperation({ summary: 'OCO order lists with legs' })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'Max lists (default 100)',
  })
  findOrderLists(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit', new DefaultValuePipe(DEFAULT_HISTORY_LIMIT), ParseIntPipe) limit: number,
  ) {
    return this.orderListService.findByUser(user.userId, MarketType.SPOT, limit);
  }

  @Get('order-lists/:id')
  @ApiOperation({ summary: 'Single OCO order list with legs' })
  @ApiParam({ name: 'id', type: String, description: 'Order list id (uuid)' })
  findOrderList(@CurrentUser() user: CurrentUserPayload, @Param('id') listId: string) {
    return this.orderListService.findOneForUser(user.userId, listId);
  }

  @Get('commission')
  @ApiOperation({ summary: 'Commission rates (bps + decimal rate string)' })
  async commission(@CurrentUser() user: CurrentUserPayload) {
    const rates = await this.userService.feeRatesOf(user.userId, MarketType.SPOT);
    return {
      feeTier: rates.tier,
      makerBps: rates.makerBps,
      takerBps: rates.takerBps,
      maker: new Decimal(rates.makerBps).div(10000).toFixed(8),
      taker: new Decimal(rates.takerBps).div(10000).toFixed(8),
    };
  }
}
